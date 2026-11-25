import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const MODEL = 'gpt-live-1';
const DELEGATED_MODEL = 'gpt-5.6-terra';
const VOICE = 'halo'; // GPT-Live's built-in British English feminine voice
const USER_AGENT = 'twilio-demos/Node 1.0.0';
const PORT = process.env.PORT || 5050;

const getOpening = () => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    return (hour < 12 ? 'Good morning' : 'Good afternoon') + ", you're through to Ashley Kissick Financial Advisers. My name's Jess, I'm the assistant. How can I help you today?";
};
const VOICE_PROMPT = `You are Jess, a friendly, concise, professional British English AI receptionist for Ashley Kissick Financial Advisers. Introduce yourself as Jess at the beginning of every call. Do not claim to be human or conceal that you are an AI if asked directly. Never mention the software vendors unless asked directly. Speak throughout in a consistent, natural British English accent, including from the very first greeting. Use a relaxed contemporary British female speaking style with British vowels and non-rhotic pronunciation. Do not use an American accent, American pronunciation or exaggerated theatrical British speech. Keep the accent stable throughout the entire conversation, with natural rhythm and calm conversational pacing. Sound like a friendly, capable woman in her thirties or forties. Sound relaxed and attentive rather than scripted or corporate. Use natural sentence lengths and gentle conversational pacing, with brief acknowledgements when useful. Allow callers time to think and finish speaking, including short pauses and hesitations; do not rush to fill silence or interrupt. If a caller starts speaking while you are talking, stop promptly and listen. Respond to the meaning of what they said rather than repeating a fixed script. Use light, appropriate small talk when the caller initiates it, but remain concise and professional. Avoid repetitive confirmations, excessive enthusiasm and unnecessary questions. Listen patiently through pauses, hesitations, spelled names and phone numbers; do not interrupt. Ask one question at a time and remember details already provided. Do not give financial advice or ask for account numbers, passwords, financial documents, or other sensitive financial information. During Monday-Friday 09:00-17:00 Europe/London, collect the caller's name and brief reason and explain that you will arrange for Ashley to speak with them. IMPORTANT: Live call transfer is NOT YET IMPLEMENTED in this test version. Never claim you are transferring or have transferred a call. If asked to transfer, explain politely that you can take a callback message during testing. Outside those hours take a message and explain it will be passed on when the office reopens. Do not promise a particular callback time. For callback numbers, prefer confirming caller ID when available, but do not claim to know caller ID unless it is explicitly provided. For any eleven-digit UK callback number, speak each digit individually in THREE DISTINCT groups: first five digits, a noticeable silent pause, next three digits, another noticeable silent pause, final three digits. Example: zero seven five two eight [pause] one eight five [pause] nine nine two. Do not say the word pause aloud. Use zero, not oh. Ask 'Have I got that right?' and wait for explicit confirmation. If the number is withheld, ask 'What's the best telephone number for Ashley to contact you on?' If caller ID is explicitly available, confirm only the last four digits first. Never invent a caller ID. If uncertain, ask for correction, never guess or invent a digit. Appointments may be requested for Tuesday, Wednesday, Thursday at 11:00 or 14:00 UK time: telephone 30 minutes with 2 hours' notice, Google Meet 60 minutes with 24 hours' notice, in-person 60 minutes with 48 hours' notice. IMPORTANT: Calendar lookup, booking, email sending and Google Meet creation are NOT YET IMPLEMENTED. You may take an appointment request but must never claim availability, a booking, email delivery or a Meet link has been confirmed. Do not claim a message was saved or sent: this test application currently does not persist messages. If the caller needs financial advice, ask 'What in particular are you looking for help with?' If Ashley is unavailable, ask 'Before you go, is there anything in particular you would like to discuss with Ashley, so he can prepare for the call?' Collect the caller's name, confirmed callback number and brief topic without sensitive financial details. Thank them and wish them a lovely day. Only for fictional TEST calls: after confirming the callback number, use the send_callback_sms tool once to alert Ashley, if available. Never ask for sensitive financial information. Only say the SMS has been sent if the tool returns sent:true; this means accepted for sending, not necessarily delivered. If the tool fails, say the notification could not be sent, and do not promise a callback or claim to have saved the message. Live transfers, email and calendar bookings remain unavailable. The current calls are fictional test calls only.`;
const BACKEND_PROMPT = 'Respond as Jess, briefly and professionally. Do not invent tool results or imply any transfer, booking or message delivery occurred.';
// Railway currently has legacy misspellings from the initial manual setup.
const accountSid = process.env.TWILIO_ACCOUNT_SID || process.env.TWILLO_ACCOUNT_SID;
const apiKeySid = process.env.TWILIO_API_KEY_SID || process.env.TWILLIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET || process.env.TWILLIO_API_KEY_SECRET;
const smsNotifyTo = process.env.AKFA_SMS_NOTIFY_TO || '';
const smsTestEnabled = process.env.ENABLE_TEST_SMS === 'true';
const isE164 = (value) => /^\+[1-9]\d{7,14}$/.test(value || '');
const cleanField = (value, maxLength) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
const xmlEscape = (value) => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TOOLS = [{
    type: 'function',
    name: 'send_callback_sms',
    description: 'Send Ashley a brief SMS for a fictional TEST callback request, once the caller has confirmed the callback number. Do not call for real client calls, and do not include sensitive financial information.',
    parameters: {
        type: 'object',
        properties: {
            caller_name: { type: 'string', description: 'The caller name as stated' },
            callback_number: { type: 'string', description: 'Confirmed callback number as stated, without guessing' },
            topic: { type: 'string', description: 'Brief non-sensitive reason for calling' }
        },
        required: ['caller_name', 'callback_number', 'topic'],
        additionalProperties: false
    }
}];

// The API key is for server-side calls only. Messages go solely to a number
// explicitly configured by the owner, never to a model-selected recipient.
async function sendCallbackSms(args, fromNumber) {
    if (!smsTestEnabled) return { sent: false, reason: 'test SMS disabled' };
    if (!accountSid || !apiKeySid || !apiKeySecret) return { sent: false, reason: 'Twilio credentials not configured' };
    if (!isE164(smsNotifyTo)) return { sent: false, reason: 'SMS notification recipient not configured' };
    if (!isE164(fromNumber)) return { sent: false, reason: 'Twilio sending number unavailable' };
    const caller = cleanField(args.caller_name, 60);
    const callback = cleanField(args.callback_number, 24);
    const topic = cleanField(args.topic, 100);
    if (!caller || !callback || !topic) return { sent: false, reason: 'missing callback details' };
    const client = twilio(apiKeySid, apiKeySecret, { accountSid });
    try {
        const message = await client.messages.create({
            to: smsNotifyTo,
            from: fromNumber,
            body: `JESS TEST CALLBACK - Name: ${caller}. Callback: ${callback}. Subject: ${topic}.`
        });
        return { sent: true, status: message.status, note: 'Twilio accepted the SMS; delivery not yet confirmed' };
    } catch (error) {
        console.error('Test SMS send failed, Twilio status:', error.status || 'unknown');
        return { sent: false, reason: 'Twilio rejected SMS send' };
    }
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ message: 'Twilio Media Stream Server is running!' }));

// Record every call (dual channel: caller and Jess separately). Set RECORD_CALLS=false on Railway to switch off.
const RECORD_CALLS = process.env.RECORD_CALLS !== 'false';

fastify.all('/incoming-call', async (request, reply) => {
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    const toNumber = String(request.body?.To || '');
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>${RECORD_CALLS ? '<Start><Recording recordingChannels="dual" trim="do-not-trim" /></Start>' : ''}<Connect><Stream url="wss://${host}/media-stream"><Parameter name="twilio_to" value="${xmlEscape(toNumber)}" /></Stream></Connect></Response>`);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {
        console.log('Client connected');

        let streamSid = null;
        let sessionRequested = false;
        let sessionReady = false;
        let twilioReceivingNumber = '';
        let smsAlreadyAttempted = false;

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
                        content: `Your first spoken line on this call is, verbatim: "${getOpening()}"` });
                    send({ type: 'session.commentary.append', delegation_id: null, content: getOpening() });
                } else if (event.type === 'session.output_audio.delta' && streamSid && connection.readyState === WebSocket.OPEN) {
                    connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
                } else if (event.type === 'response.event'
                    && event.event?.type === 'response.output_item.done'
                    && event.event.item?.type === 'function_call' && event.event.item.status === 'completed') {
                    const { call_id, name, arguments: args } = event.event.item;
                    // No call arguments or sensitive caller content are logged.
                    let output = { sent: false, reason: 'unknown tool' };
                    if (name === 'send_callback_sms') {
                        if (smsAlreadyAttempted) {
                            output = { sent: false, reason: 'SMS already attempted on this call' };
                        } else {
                            smsAlreadyAttempted = true; // no duplicate sends if the provider times out
                            output = await sendCallbackSms(JSON.parse(args || '{}'), twilioReceivingNumber);
                        }
                    }
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
                    twilioReceivingNumber = String(data.start.customParameters?.twilio_to || '');
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