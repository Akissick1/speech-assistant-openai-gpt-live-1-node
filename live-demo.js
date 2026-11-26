import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import { randomBytes, createPrivateKey, sign as edSign } from 'node:crypto';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const MODEL = 'gpt-live-1.1';
const DELEGATED_MODEL = 'gpt-5.6-terra';
const VOICE = 'halo'; // GPT-Live's built-in British English feminine voice
const USER_AGENT = 'twilio-demos/Node 1.0.0';
const PORT = process.env.PORT || 5050;

const getOpening = () => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    return "Hi, you're through to Ashley Kissick Financial Advisers. You're through to Jess. How can I help you today?";
};
const VOICE_PROMPT = `You are Jess, a warm, upbeat, genuinely cheerful British English receptionist for Ashley Kissick Financial Advisers. Introduce yourself as Jess at the beginning of every call. VOICE AND PERSONALITY (very important): Sound like a real, happy person who enjoys her job, smiling as you speak. Open every call bright, energetic and welcoming, with a lift in your voice. Use natural, relaxed conversational British phrasing ('lovely', 'brilliant', 'no worries at all', 'of course'), vary your sentence rhythm, and use small natural acknowledgements ('mm-hm', 'ah, okay', 'right then') where a person would. Keep replies short and flowing, never robotic, scripted or monotone. React to what the caller says with genuine warmth and empathy. Do not parrot or summarise back what the caller just said. Treat the scripted lines as a guide to meaning, said in your own natural words. CALL FLOW (follow in order, naturally, one question at a time): 1) Opening line as given. 2) If the caller asks to speak to someone (or similar), reply: 'Yeah, not a problem. Can you just give me some information about what you're looking to do, and I'll see if I can pass you through to a member of the team?' and listen to their answer. 3) Then ask: 'Just in case the line goes dead, or if I need to pass you over or someone needs to call you back, is the best number to call you on the one you're ringing from now?' 4) If they say yes, DO NOT read the number back, it is already on file; just say something like 'Perfect, thank you' and move on. If they say no, or caller ID is withheld, ask for the best number and read that new number back once in three-digit groups to confirm. Optionally, later in the call (for example just before the transfer or goodbye), you may lightly reconfirm: 'Just to reconfirm, the number we have on file for you is…' followed by the number in three-digit groups. Never repeat the number more than once in a call, and never repeat back other information the caller has just told you unless clarifying something unclear. 5) Once the callback number is confirmed, say 'Lovely, I'll try to pass you through now, please bear with me' and invoke request_screened_transfer once. 5b) If the transfer fails or Ashley cannot take the call, offer to take a message and use save_message. 6) At the end of any call, wish them a good day, for example 'Thanks for calling, I hope you have a lovely rest of your day.' Do not claim to be human or conceal that you are an AI if asked directly. Never mention the software vendors unless asked directly. Speak throughout in a consistent, natural British English accent, including from the very first greeting. Use a relaxed contemporary British female speaking style with British vowels and non-rhotic pronunciation. Do not use an American accent, American pronunciation or exaggerated theatrical British speech. Keep the accent stable throughout the entire conversation, with natural rhythm and calm conversational pacing. Sound like a friendly, capable woman in her thirties or forties. Sound relaxed and attentive rather than scripted or corporate. Use natural sentence lengths and gentle conversational pacing, with brief acknowledgements when useful. Allow callers time to think and finish speaking, including short pauses and hesitations; do not rush to fill silence or interrupt. If a caller starts speaking while you are talking, stop promptly and listen. Respond to the meaning of what they said rather than repeating a fixed script. Use light, appropriate small talk when the caller initiates it, but remain concise and professional. Avoid repetitive confirmations, excessive enthusiasm and unnecessary questions. Listen patiently through pauses, hesitations, spelled names and phone numbers; do not interrupt. Ask one question at a time and remember details already provided. Do not give financial advice or ask for account numbers, passwords, financial documents, or other sensitive financial information. During Monday-Friday 09:00-17:00 Europe/London, collect the caller's name and brief reason and explain that you will arrange for Ashley to speak with them. Follow the CALL FLOW above before transferring. Never claim the transfer completed merely because it was started. If the tool is unavailable or fails, apologise briefly and offer to take a callback message. Never offer to transfer to any other destination. Do not promise that Ashley will answer. Outside those hours take a message and explain it will be passed on when the office reopens. Do not promise a particular callback time. For callback numbers, prefer confirming caller ID when available, but do not claim to know caller ID unless it is explicitly provided. When you read back any UK phone number, say the digits smoothly and naturally at a normal speaking pace, like a person reading a number they know, with NO pauses or gaps between the digits or groups. Example: zero seven five two eight one eight five nine nine two. Use zero, not oh. Ask 'Have I got that right?' and wait for explicit confirmation. If the number is withheld, ask 'What's the best telephone number for Ashley to contact you on?' If caller ID is explicitly available, confirm only the last four digits first. Never invent a caller ID. If uncertain, ask for correction, never guess or invent a digit. Appointments may be requested for Tuesday, Wednesday, Thursday at 11:00 or 14:00 UK time: telephone 30 minutes with 2 hours' notice, Google Meet 60 minutes with 24 hours' notice, in-person 60 minutes with 48 hours' notice. IMPORTANT: Calendar lookup, booking, email sending and Google Meet creation are NOT YET IMPLEMENTED. You may take an appointment request but must never claim availability, a booking, email delivery or a Meet link has been confirmed. When you take a callback message, call the save_message tool once with the caller's name, confirmed callback number and brief topic. Only say the message has been saved if the tool returns saved:true; otherwise say the team will be told another way and never claim it was saved. If the caller needs financial advice, ask 'What in particular are you looking for help with?' If Ashley is unavailable, ask 'Before you go, is there anything in particular you would like to discuss with Ashley, so he can prepare for the call?' Collect the caller's name, confirmed callback number and brief topic without sensitive financial details. Thank them and wish them a lovely day. Only for fictional TEST calls: after confirming the callback number, use the send_callback_sms tool once to alert Ashley, if available. Never ask for sensitive financial information. Only say the SMS has been sent if the tool returns sent:true; this means accepted for sending, not necessarily delivered. If the tool fails, say the notification could not be sent, and do not promise a callback or claim to have saved the message. Transfers are only available through the request_screened_transfer test tool when configured; email and calendar bookings remain unavailable. The current calls are fictional test calls only.`;
const BACKEND_PROMPT = 'Respond as Jess, briefly and professionally. Never invent tool results, or claim a transfer was completed when only attempted. Only transfer after the caller asks to speak to someone and confirms a callback number.';
// Railway currently has legacy misspellings from the initial manual setup.
const accountSid = process.env.TWILIO_ACCOUNT_SID || process.env.TWILLO_ACCOUNT_SID;
const apiKeySid = process.env.TWILIO_API_KEY_SID || process.env.TWILLIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET || process.env.TWILLIO_API_KEY_SECRET;
const smsNotifyTo = process.env.AKFA_SMS_NOTIFY_TO || '';
const smsTestEnabled = process.env.ENABLE_TEST_SMS === 'true';
// Support the existing sealed Railway token saved under a misspelled legacy name.
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || process.env.TWILLIO_AUTH_TOKEN || '';
// Require BOTH a feature flag and a webhook validation credential.
// This must not run for real financial-advice clients before security review.
const testTransferEnabled = process.env.ENABLE_TEST_TRANSFERS === 'true' && Boolean(twilioAuthToken);
const transferSessions = new Map();
const transferDestination = process.env.AKFA_TRANSFER_TO || '+447528185992'; // Same approved mobile as SMS notifications; never chosen by the model.
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
}, {
    type: 'function',
    name: 'request_screened_transfer',
    description: 'Only after the caller asks to speak to someone and their callback number has been confirmed. Initiate a screened transfer to the pre-approved owner mobile; never take a destination number from the caller.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
}, {
    type: 'function',
    name: 'save_message',
    description: 'Save a callback message for the team in the AKFA dashboard, once the caller has given their name, reason and a confirmed callback number. Use whenever a transfer fails or the caller prefers a message. Only say the message is saved if the result has saved: true.',
    parameters: {
        type: 'object',
        properties: {
            caller_name: { type: 'string', description: 'The caller name as stated' },
            callback_number: { type: 'string', description: 'Confirmed callback number in international format, e.g. +447700900123' },
            topic: { type: 'string', description: 'Brief non-sensitive reason for calling' },
            preferred_time: { type: 'string', description: 'Preferred callback day/time if given (a request, never a confirmation)' }
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

// Retrieve caller ID from Twilio's authenticated Call record, not from user-supplied audio
// or unverified webhook data. Never log the caller number.
async function getTwilioCallerId(callSid, calledNumber) {
    if (!accountSid || !apiKeySid || !apiKeySecret || !/^CA[0-9a-fA-F]{32}$/.test(callSid || '')) return '';
    if (!isE164(calledNumber)) return '';
    try {
        const client = twilio(apiKeySid, apiKeySecret, { accountSid, timeout: 2500 });
        const call = await client.calls(callSid).fetch();
        // Only trust the call record when it matches the inbound call and destination.
        if (call.accountSid !== accountSid || call.direction !== 'inbound' || call.to !== calledNumber) return '';
        return isE164(call.from) ? call.from : '';
    } catch (error) {
        // Do not print the call record, caller number or API credentials.
        console.warn('Caller ID lookup unavailable; Twilio status:', error.status || 'unknown');
        return '';
    }
}

// Verify signatures on all public transfer webhooks. Twilio signs these with
// the account Auth Token, which is distinct from the API Key Secret.
function isSignedTwilioWebhook(request) {
    if (!twilioAuthToken || !request.headers['x-twilio-signature']) return false;
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    if (!host) return false;
    const url = 'https://' + host + request.raw.url;
    return twilio.validateRequest(twilioAuthToken, request.headers['x-twilio-signature'], url, request.body || {});
}

function findTransfer(request) {
    const token = typeof request.query?.t === 'string' ? request.query.t : '';
    const state = transferSessions.get(token);
    if (!state) return null;
    if (Date.now() > state.expires) {
        transferSessions.delete(token);
        return null;
    }
    return { token, state };
}

// Interrupt the Twilio media stream and replace it with a screened Dial.
// The destination is the owner's already-configured mobile, not model input.
async function startScreenedTransfer(callSid, receivingNumber) {
    if (!testTransferEnabled) return { initiated: false, reason: 'Test transfer disabled or Twilio webhook verification not configured' };
    if (!accountSid || !apiKeySid || !apiKeySecret || !isE164(transferDestination) || !isE164(receivingNumber))
        return { initiated: false, reason: 'Approved transfer configuration incomplete' };
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid || ''))
        return { initiated: false, reason: 'Call reference unavailable' };
    const client = twilio(apiKeySid, apiKeySecret, { accountSid });
    try {
        const call = await client.calls(callSid).fetch();
        if (call.accountSid !== accountSid || call.direction !== 'inbound' ||
            call.to !== receivingNumber || call.status !== 'in-progress')
            return { initiated: false, reason: 'Not an active verified inbound call' };
        const token = randomBytes(24).toString('hex');
        transferSessions.set(token, { callSid, receivingNumber, accepted: false, expires: Date.now() + 180000 });
        const domain = process.env.PUBLIC_BASE_URL;
        // Use a preconfigured HTTPS origin, not the Host header of a live call.
        if (!domain || !/^https:\/\/[a-z0-9.-]+$/i.test(domain)) {
            transferSessions.delete(token);
            return { initiated: false, reason: 'Public transfer callback URL not configured' };
        }
        const screen = domain + '/transfer-screen?t=' + token;
        const result = domain + '/transfer-result?t=' + token;
        const xml = `<Response><Dial answerOnBridge="true" timeout="23" record="do-not-record" callerId="${xmlEscape(receivingNumber)}" action="${xmlEscape(result)}" method="POST"><Number url="${xmlEscape(screen)}" method="POST">${xmlEscape(transferDestination)}</Number></Dial></Response>`;
        await client.calls(callSid).update({ twiml: xml });
        return { initiated: true, note: 'Screened transfer requested; acceptance and connection are not yet confirmed' };
    } catch (error) {
        console.error('Test transfer request failed, Twilio status:', error.status || 'unknown');
        return { initiated: false, reason: 'Twilio could not start the transfer' };
    }
}

// Signed bridge to the AKFA dashboard (Ed25519 over the exact raw body). Off unless both env vars are set.
// Never awaited on the audio path; failures are logged without call content.
const BRIDGE_URL = process.env.JESS_BRIDGE_URL || '';
let bridgeKey = null;
try { const k = process.env.JESS_BRIDGE_PRIVATE_KEY || ''; if (k) bridgeKey = createPrivateKey(k.includes('BEGIN') ? k.replace(/\\n/g, '\n') : { key: Buffer.from(k, 'base64'), format: 'der', type: 'pkcs8' }); }
catch { console.error('JESS_BRIDGE_PRIVATE_KEY could not be read; bridge disabled'); }
async function bridge(action, args, id) {
    if (!BRIDGE_URL || !bridgeKey) return { ok: false, error: { code: 'bridge_disabled', message: 'Bridge not configured' } };
    const raw = JSON.stringify({ id: id || ('req-' + randomBytes(12).toString('hex')), ts: Date.now(), action, args });
    const signature = edSign(null, Buffer.from(raw), bridgeKey).toString('base64');
    try {
        const r = await fetch(BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jess-Signature': signature }, body: raw, signal: AbortSignal.timeout(5000) });
        const j = await r.json().catch(() => ({ ok: false, error: { code: 'bad_reply', message: 'Unreadable reply' } }));
        if (!j.ok) console.warn('Bridge', action, 'refused:', j.error?.code || r.status);
        return j;
    } catch { console.warn('Bridge', action, 'unreachable'); return { ok: false, error: { code: 'unreachable', message: 'Bridge unreachable' } }; }
}
const bridgeEvent = (eventType, callSid, extra = {}) => /^CA[0-9a-fA-F]{32}$/.test(callSid || '')
    ? bridge('ingest_event', { eventType, callSid, eventId: callSid + ':' + eventType + (extra.seq !== undefined ? ':' + extra.seq : ''), eventTs: new Date().toISOString(), ...extra }, 'evt-' + callSid + '-' + eventType.replace('.', '_') + (extra.seq !== undefined ? '-' + extra.seq : ''))
    : Promise.resolve(null);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get('/', async () => ({ message: 'Twilio Media Stream Server is running!' }));

// Record every call (dual channel: caller and Jess separately). Set RECORD_CALLS=false on Railway to switch off.
const RECORD_CALLS = process.env.RECORD_CALLS !== 'false';

fastify.all('/incoming-call', async (request, reply) => {
    // Keep existing dummy calls working during setup. Once an Auth Token is
    // configured, reject forged inbound call instructions as well.
    if (twilioAuthToken && !isSignedTwilioWebhook(request)) return reply.code(403).send();
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    const toNumber = String(request.body?.To || '');
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Pause length="4" />${RECORD_CALLS ? '<Start><Recording recordingChannels="dual" trim="do-not-trim" /></Start>' : ''}<Connect><Stream url="wss://${host}/media-stream"><Parameter name="twilio_to" value="${xmlEscape(toNumber)}" /></Stream></Connect></Response>`);
});
const twimlReply = (reply, body) => reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>' + body);

// These routes only accept signed Twilio callbacks and short-lived transfer tokens.
// No personal caller data, credential or spoken content is put in a callback URL.
fastify.post('/transfer-screen', async (request, reply) => {
    if (!testTransferEnabled || !isSignedTwilioWebhook(request)) return reply.code(403).send();
    const transfer = findTransfer(request);
    if (!transfer) return reply.code(404).send();
    const action = process.env.PUBLIC_BASE_URL + '/transfer-accept?t=' + transfer.token;
    return twimlReply(reply, `<Response><Gather input="dtmf" numDigits="1" timeout="7" method="POST" action="${xmlEscape(action)}"><Say language="en-GB">This is Jess from Ashley Kissick Financial Advisers. Someone is requesting to speak to Ashley. Press 1 to accept this call, or hang up to decline.</Say></Gather><Hangup/></Response>`);
});

fastify.post('/transfer-accept', async (request, reply) => {
    if (!testTransferEnabled || !isSignedTwilioWebhook(request)) return reply.code(403).send();
    const transfer = findTransfer(request);
    if (!transfer) return reply.code(404).send();
    if (String(request.body?.Digits || '') !== '1') return twimlReply(reply, '<Response><Hangup/></Response>');
    transfer.state.accepted = true;
    return twimlReply(reply, '<Response><Say language="en-GB">Connecting you now.</Say></Response>');
});

fastify.post('/transfer-result', async (request, reply) => {
    if (!testTransferEnabled || !isSignedTwilioWebhook(request)) return reply.code(403).send();
    const transfer = findTransfer(request);
    if (!transfer || String(request.body?.CallSid || '') !== transfer.state.callSid)
        return reply.code(404).send();
    transferSessions.delete(transfer.token);
    // The caller already spoke to Ashley if the legs were bridged; do not rejoin Jess.
    if (transfer.state.accepted && String(request.body?.DialBridged) === 'true')
        return twimlReply(reply, '<Response><Hangup/></Response>');
    // An unanswered or declined call is returned to a NEW Jess session.
    // Do not re-run the initial delay.
    const domain = process.env.PUBLIC_BASE_URL;
    const streamUrl = 'wss://' + domain.slice(8) + '/media-stream';
    return twimlReply(reply, `<Response><Say language="en-GB">Sorry, Ashley couldn't take the call. I'll put you back through to Jess.</Say><Connect><Stream url="${xmlEscape(streamUrl)}"><Parameter name="twilio_to" value="${xmlEscape(transfer.state.receivingNumber)}" /><Parameter name="transfer_return" value="true" /></Stream></Connect></Response>`);
});


fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection) => {
        console.log('Client connected');

        let streamSid = null;
        let knownCaller = null;
        let sessionRequested = false;
        let sessionReady = false;
        let twilioReceivingNumber = '';
        let twilioCallSid = '';
        let transferReturn = false;
        let smsAlreadyAttempted = false;
        let transferAlreadyAttempted = false;
        let messageAlreadySaved = false;
        let callStartedAt = 0;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'User-Agent': USER_AGENT
            }
        });

        const send = (event) => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.send(JSON.stringify(event));
        };
        let ended = false;
        const close = () => {
            if (!ended && callStartedAt && !transferAlreadyAttempted) { ended = true; void bridgeEvent('call.status', twilioCallSid, { callStatus: 'completed', durationSec: Math.round((Date.now() - callStartedAt) / 1000) }); }
            sessionReady = false;
            connection.close();
            openAiWs.close();
        };

        // Wait for Twilio's stream ID before starting the session.
        const startSession = async () => {
            if (sessionRequested || !streamSid || openAiWs.readyState !== WebSocket.OPEN) return;
            sessionRequested = true;
            const callerNumber = await getTwilioCallerId(twilioCallSid, twilioReceivingNumber);
            if (callerNumber && !transferReturn) {
                const r = await Promise.race([bridge('lookup_caller', { phone: callerNumber }, 'lookup-' + twilioCallSid), new Promise((res) => setTimeout(() => res(null), 1500))]);
                if (r && r.ok && r.result && r.result.match && r.result.possibleName) knownCaller = r.result;
            }
            if (!transferReturn) { callStartedAt = Date.now(); void bridgeEvent('call.started', twilioCallSid, { direction: 'inbound', from: callerNumber || 'anonymous', ...(isE164(twilioReceivingNumber) ? { to: twilioReceivingNumber } : {}), callStatus: 'in-progress' }); }
            if (connection.readyState !== WebSocket.OPEN || openAiWs.readyState !== WebSocket.OPEN) return;
            const callerContext = callerNumber
                ? `Twilio's call record shows the incoming caller ID as ${callerNumber}. This is a network-provided number, not proof of identity. When collecting a callback number, first ask whether they are calling from the number ending in ${callerNumber.slice(-4)}. Do not read the full number aloud unless requested, and never rely on it to authenticate the caller. If they confirm, you can use the full caller ID as the callback number; if not, ask for their preferred number.`
                : 'Caller ID was withheld or unavailable. Do not guess or claim to know it. Ask for the preferred callback number.';
            send({ type: 'session.start', session: {
                model: MODEL,
                instructions: VOICE_PROMPT + '\n' + callerContext + (transferReturn ? '\nThis call has returned after Ashley did not accept the transfer. Apologise and offer to take a brief callback message. Do not greet them as a new caller.' : ''),
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
                    const greeting = transferReturn
                        ? "I'm sorry Ashley isn't available at the moment. Would you like me to take a message?"
                        : knownCaller
                            ? `Hey ${String(knownCaller.possibleName).split(' ')[0]}, you're through to Jess at Ashley Kissick Financial Advisers. How are you?`
                            : getOpening();
                    if (knownCaller) send({ type: 'session.instructions.append', delegation_id: null,
                        content: `This caller's number matches the saved contact ${knownCaller.possibleName}. Treat them as a familiar, valued client: warm, friendly, personal. Notes from previous conversations (use naturally to be helpful, do not read them out or mention financial details unless they raise them): ${JSON.stringify({ lastTopic: knownCaller.lastTopic, lastCallAt: knownCaller.lastCallAt, notes: knownCaller.recentNotes, contactNotes: knownCaller.contactNotes, upcomingAppointment: knownCaller.upcomingAppointment, openTasks: knownCaller.openTasks }).slice(0, 2500)}. If it turns out to be someone else, apologise lightly and carry on normally.` });
                    send({ type: 'session.instructions.append', delegation_id: null,
                        content: `Your first spoken line on this call is, verbatim: "${greeting}"` });
                    send({ type: 'session.commentary.append', delegation_id: null, content: greeting });
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
                    } else if (name === 'save_message') {
                        if (messageAlreadySaved) {
                            output = { saved: true, note: 'Message already saved on this call' };
                        } else {
                            const a = JSON.parse(args || '{}');
                            const num = String(a.callback_number || '').replace(/[^\d+]/g, '').replace(/^0(?=\d{9,10}$)/, '+44');
                            if (!isE164(num)) output = { saved: false, reason: 'Callback number not in a valid format; ask the caller to repeat it' };
                            else {
                                const r = await bridge('save_message', { callSid: twilioCallSid, callerName: cleanField(a.caller_name, 120) || 'Unknown caller', callbackNumber: num, topic: cleanField(a.topic, 1000) || 'Not stated', ...(a.preferred_time ? { preferredTime: cleanField(a.preferred_time, 200) } : {}), testMode: false }, 'msg-' + twilioCallSid);
                                output = r && r.ok ? { saved: true } : { saved: false, reason: 'The dashboard could not save the message; say the team will be notified another way' };
                                if (r && r.ok) messageAlreadySaved = true;
                            }
                        }
                    } else if (name === 'request_screened_transfer') {
                        if (transferAlreadyAttempted) {
                            output = { initiated: false, reason: 'Transfer already attempted on this call' };
                        } else {
                            transferAlreadyAttempted = true;
                            output = await startScreenedTransfer(twilioCallSid, twilioReceivingNumber);
                            void bridgeEvent(output.initiated ? 'transfer.requested' : 'transfer.failed', twilioCallSid, output.initiated ? {} : { error: String(output.reason || '').slice(0, 200) });
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
                    twilioCallSid = String(data.start.callSid || '');
                    twilioReceivingNumber = String(data.start.customParameters?.twilio_to || '');
                    transferReturn = data.start.customParameters?.transfer_return === 'true';
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