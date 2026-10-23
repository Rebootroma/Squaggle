// Browser test call, no FaceTime line needed.
//
// Creates a LiveKit room that looks like a Chert call (room metadata carries chert_bridge_ready so the
// agent greets), dispatches the agent into it, and prints a meet.livekit.io link. Open the link on any
// phone or laptop, allow camera + mic, and talk to the agent exactly as a FaceTime caller would.
//
//   node --env-file=.env.local scripts/test-call.mjs
//
// The agent must be running (npm start) with the same AGENT_NAME.
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

const url = process.env.LIVEKIT_URL;
const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;
const agentName = process.env.AGENT_NAME || 'quote-agent';
if (!url || !key || !secret) { console.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing in .env.local'); process.exit(2); }

const httpUrl = url.replace(/^wss?:/, m => (m === 'wss:' ? 'https:' : 'http:'));
const roomName = `test-call-${Date.now().toString(36)}`;
const callerIdentity = `chert-bridge-test-${Math.random().toString(36).slice(2, 8)}`;

const rooms = new RoomServiceClient(httpUrl, key, secret);
await rooms.createRoom({
  name: roomName,
  emptyTimeout: 300,
  metadata: JSON.stringify({ chert_call: 'browser-test', chert_bridge_ready: true, at: new Date().toISOString() }),
});

const dispatch = new AgentDispatchClient(httpUrl, key, secret);
const d = await dispatch.createDispatch(roomName, agentName, { metadata: JSON.stringify({ source: 'test-call' }) });

const at = new AccessToken(key, secret, { identity: callerIdentity, name: 'Homeowner (browser)', ttl: '1h' });
at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
const token = await at.toJwt();

const meet = `https://meet.livekit.io/custom?liveKitUrl=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;

console.log(`room:      ${roomName}`);
console.log(`agent:     ${agentName}  (dispatch ${d.id})`);
console.log(`caller:    ${callerIdentity}`);
console.log('');
console.log('Open this on a phone or laptop (allow camera + microphone), then speak:');
console.log(meet);
