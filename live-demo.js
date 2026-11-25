import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const MODEL = 'gpt-live-1';
const DELEGATED_MODEL = 'gpt-5.6-terra';
const VOICE = 'marin';
const USER_AGENT = 'twilio-demos/Node 1.0.0';
const PORT = process.env.PORT || 5050;

const OPENING = "Good morning, Ashley Kissick Financial Advisers, Jess speaking. How can I help?";
const VOICE_PROMPT = `You are Jess, a friendly, concise, professional British English AI receptionist for Ashley Kissick Financial Advisers. Introduce yourself as Jess at the beginning of every call. Do not claim to be human or conceal that you are an AI if asked directly. Never mention the software vendors unless asked directly. Speak in a warm, natural, conversational British English style, like a friendly, capable woman in her thirties or forties. Sound relaxed and attentive rather than scripted or corporate. Use natural sentence lengths and gentle conversational pacing, with brief acknowledgements when useful. Allow callers time to think and finish speaking, including short pauses and hesitations; do not rush to fill silence or interrupt. If a caller starts speaking while you are talking, stop promptly and listen. Respond to the meaning of what they said rather than repeating a fixed script. Use light, appropriate small talk when the caller initiates it, but remain concise and professional. Avoid repetitive confirmations, excessive enthusiasm and unnecessary questions. Listen patiently through pauses, hesitations, spelled names and phone numbers; do not interrupt. Ask one question at a time and remember details already provided. Do not give financial advice or ask for account numbers, passwords, financial documents, or other sensitive financial information. During Monday-Friday 09:00-17:00 Europe/London, collect the caller's name and brief reason and explain that you will arrange for Ashley to speak with them. IMPORTANT: Live call transfer is NOT YET IMPLEMENTED in this test version. Never claim you are transferring or have transferred a call. If asked to transfer, explain politely that you can take a callback message during testing. Outside those hours take a message and explain it will be passed on when the office reopens. Do not promise a particular callback time. For callback numbers, prefer confirming caller ID when available, but do not claim to know caller ID unless it is explicitly provided. Repeat digits in natural groups, interpreting 'oh' as zero, and wait for an explicit confirmation. If uncertain, ask for correction, never guess or invent a digit. Appointments may be requested for Tuesday, Wednesday, Thursday at 11:00 or 14:00 UK time: telephone 30 minutes with 2 hours' notice, Google Meet 60 minutes with 24 hours' notice, in-person 60 minutes with 48 hours' notice. IMPORTANT: Calendar lookup, booking, email sending and Google Meet creation are NOT YET IMPLEMENTED. You may take an appointment request but must never claim availability, a booking, email delivery or a Meet link has been confirmed. Do not claim a message was saved or sent: this test application currently does not persist messages. The current calls are fictional test calls only.`;
const BACKEND_PROMPT = 'Respond as Jess, briefly and professionally. Do not invent tool results or imply any transfer, booking or message delivery occurred.';
const TOOLS = [];

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ message: 'Twilio Media Stream Server is running!' }));

fastify.all('/incoming-call', async (request, reply) => {
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {
        console.log('Client connected');

        let streamSid = null;
        let sessionRequested = false;
        let sessionReady = false;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'User-Agent': USER_AGENT
            }
        });

        const send = (event) => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.send(JSON.stringify(event));
        };
        const close = () => {
            sessionReady = false;
            connection.close();
            openAiWs.close();
        };

        // Wait for Twilio's stream ID before starting the session.
        const startSession = () => {
            if (sessionRequested || !streamSid || openAiWs.readyState !== WebSocket.OPEN) return;
            sessionRequested = true;
            send({ type: 'session.start', session: {
                model: MODEL,
                instructions: VOICE_PROMPT,
                audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: VOICE } },
                delegation: {
                    type: 'responses',
                    responses: { model: DELEGATED_MODEL, instructions: BACKEND_PROMPT, tools: TOOLS }
                }
            } });
        };

        openAiWs.on('open', () => {
            console.log('Connected to GPT-Live-1');
            startSession();
        });

        openAiWs.on('message', async (data) => {
            try {
                const event = JSON.parse(data);

                if (event.type === 'session.started') {
                    sessionReady = true;
                    // Quote this ID if you ever need OpenAI's help with a call.
                    console.log('GPT-Live-1 session started');
                    send({ type: 'session.instructions.append', delegation_id: null,
                        content: `Your first spoken line on this call is, verbatim: "${OPENING}"` });
                    send({ type: 'session.commentary.append', delegation_id: null, content: OPENING });
                } else if (event.type === 'session.output_audio.delta' && streamSid && connection.readyState === WebSocket.OPEN) {
                    connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
                } else if (event.type === 'response.event'
                    && event.event?.type === 'response.output_item.done'
                    && event.event.item?.type === 'function_call' && event.event.item.status === 'completed') {
                    const { call_id, name, arguments: args } = event.event.item;
                    // Do not log tool arguments: they may contain personal information.
                    const output = name === 'get_top_headline'
                        ? await getTopHeadline(JSON.parse(args))
                        : { error: 'unknown tool' };
                    send({ type: 'response.item.create',
                        item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } });
                    send({ type: 'response.create' });
                } else if (event.type === 'session.output_transcript.delta') {
                    // Do not log caller-facing transcript fragments.
                } else if (event.type === 'error') {
                    console.error('GPT-Live-1 error:', event.error);
                }
            } catch (error) { console.error('Error processing the GPT-Live-1 message:', error); }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.event === 'media' && sessionReady && openAiWs.readyState === WebSocket.OPEN) {
                    send({ type: 'session.input_audio.append', audio: data.media.payload });
                } else if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    console.log('Incoming stream has started');
                    startSession();
                } else if (data.event === 'stop') {
                    close();
                }
            } catch (error) { console.error('Error parsing Twilio message:', error); }
        });

        connection.on('close', () => { close(); console.log('Client disconnected.'); });
        connection.on('error', close);
        openAiWs.on('close', (code, reason) => {
            close();
            console.log('Disconnected from GPT-Live-1', code, reason.toString());
        });
        openAiWs.on('error', (error) => { console.error('Error in the OpenAI WebSocket:', error); close(); });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Server is listening on port ${PORT}`);
});