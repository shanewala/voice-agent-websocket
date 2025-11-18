import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

console.log('[Startup] Server starting...');
console.log('[Startup] PORT:', PORT);
console.log('[Startup] All SUPABASE env vars:', Object.keys(process.env).filter(k => k.includes('SUPABASE')));
console.log('[Startup] SUPABASE_URL present:', !!process.env.SUPABASE_URL);
console.log('[Startup] SUPABASE_ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY);

app.get('/', (req, res) => {
  res.send('Voice Agent WebSocket Server Running');
});

wss.on('connection', async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agentId = url.searchParams.get('agent_id');
    const callSid = url.searchParams.get('call_sid');

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    console.log('[Setup] Checking credentials - URL:', supabaseUrl ? 'present' : 'missing', 'Key:', supabaseKey ? 'present' : 'missing');

    if (!supabaseUrl || !supabaseKey) {
      console.error('[Setup] Missing Supabase credentials');
      console.error('[Setup] Available env vars:', Object.keys(process.env).filter(k => k.includes('SUPABASE')));
      ws.close();
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    let deepgramWs = null;
    let elevenLabsWs = null;
    let conversationContext = [];
    let streamSid = null;
    let currentTranscript = '';
    let isSpeaking = false;
    let agent = null;
    let elevenLabsKey = null;
    let openaiKey = null;
    let deepgramKey = null;

    console.log('[Twilio] WebSocket connected');

    if (!agentId) {
      console.error('[Setup] Missing agent_id');
      ws.close();
      return;
    }

    const { data: agentData } = await supabase
      .from('voice_agents')
      .select('*, clients(owner_id)')
      .eq('id', agentId)
      .maybeSingle();

    if (!agentData) {
      console.error('[Setup] Agent not found');
      ws.close();
      return;
    }

    agent = agentData;
    conversationContext.push({ role: 'system', content: agent.system_prompt });

    const { data: apiKeys } = await supabase
      .from('api_keys')
      .select('*')
      .eq('owner_id', agent.clients.owner_id)
      .in('service_name', ['elevenlabs', 'openai', 'deepgram']);

    elevenLabsKey = apiKeys?.find(k => k.service_name === 'elevenlabs')?.api_key || null;
    openaiKey = apiKeys?.find(k => k.service_name === 'openai')?.api_key || null;
    deepgramKey = apiKeys?.find(k => k.service_name === 'deepgram')?.api_key || null;

    if (!elevenLabsKey || !openaiKey || !deepgramKey) {
      console.error('[Setup] Missing required API keys');
      ws.close();
      return;
    }

    console.log('[Setup] Agent and keys loaded successfully');

    deepgramWs = new WebSocket(
      'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true',
      { headers: { 'Authorization': `Token ${deepgramKey}` } }
    );

    deepgramWs.on('open', () => {
      console.log('[Deepgram] Connected');
    });

    deepgramWs.on('message', async (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.channel?.alternatives?.[0]?.transcript) {
          const transcript = parsed.channel.alternatives[0].transcript;
          const isFinal = parsed.is_final;

          if (transcript.trim()) {
            currentTranscript = transcript;

            if (isFinal && !isSpeaking) {
              console.log('[Transcript] Final:', transcript);
              conversationContext.push({ role: 'user', content: transcript });
              await generateAndStreamResponse();
              currentTranscript = '';
            }
          }
        }
      } catch (error) {
        console.error('[Deepgram] Message error:', error);
      }
    });

    deepgramWs.on('error', (error) => {
      console.error('[Deepgram] Error:', error);
    });

    deepgramWs.on('close', () => {
      console.log('[Deepgram] Disconnected');
    });

    ws.on('message', async (message) => {
      try {
        const msg = JSON.parse(message.toString());

        if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          console.log('[Twilio] Stream started:', streamSid);

          if (agent?.greeting_message) {
            conversationContext.push({ role: 'assistant', content: agent.greeting_message });
            await speakText(agent.greeting_message);
          }
        } else if (msg.event === 'media' && deepgramWs?.readyState === WebSocket.OPEN) {
          const audioPayload = msg.media.payload;
          deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
          const audioBuffer = Buffer.from(audioPayload, 'base64');
          deepgramWs.send(audioBuffer);
        } else if (msg.event === 'stop') {
          console.log('[Twilio] Stream stopped');
          cleanup();
        }
      } catch (error) {
        console.error('[Twilio] Message error:', error);
      }
    });

    ws.on('error', (error) => {
      console.error('[Twilio] Error:', error);
      cleanup();
    });

    ws.on('close', () => {
      console.log('[Twilio] WebSocket closed');
      cleanup();

      if (callSid) {
        supabase
          .from('call_logs')
          .update({ status: 'completed', ended_at: new Date().toISOString() })
          .eq('call_sid', callSid)
          .then(() => console.log('[DB] Call log updated'));
      }
    });

    async function generateAndStreamResponse() {
      try {
        isSpeaking = true;
        console.log('[OpenAI] Generating response...');

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: conversationContext,
            max_tokens: 150,
            temperature: 0.7,
            stream: false,
          }),
        });

        const result = await response.json();
        const assistantMessage = result.choices?.[0]?.message?.content;

        if (assistantMessage) {
          console.log('[OpenAI] Response:', assistantMessage);
          conversationContext.push({ role: 'assistant', content: assistantMessage });
          await speakText(assistantMessage);
        }

        isSpeaking = false;
      } catch (error) {
        console.error('[OpenAI] Error:', error);
        isSpeaking = false;
      }
    }

    async function speakText(text) {
      try {
        console.log('[ElevenLabs] Speaking:', text);

        const voiceId = agent?.elevenlabs_voice_id || '21m00Tcm4TlvDq8ikWAM';
        elevenLabsWs = new WebSocket(
          `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2_5&optimize_streaming_latency=4`
        );

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] Connected');
          elevenLabsWs.send(JSON.stringify({
            text: text,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
            xi_api_key: elevenLabsKey,
          }));
          elevenLabsWs.send(JSON.stringify({ text: '' }));
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.audio) {
              if (ws.readyState === WebSocket.OPEN && streamSid) {
                ws.send(JSON.stringify({
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: parsed.audio,
                  },
                }));
              }
            }
          } catch (error) {
            console.error('[ElevenLabs] Message error:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] Error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] Disconnected');
        });
      } catch (error) {
        console.error('[ElevenLabs] Speak error:', error);
      }
    }

    function cleanup() {
      if (deepgramWs?.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    }
  } catch (error) {
    console.error('[Server] Error:', error);
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
