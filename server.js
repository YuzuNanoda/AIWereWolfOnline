const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout: 120000,
  pingInterval: 25000
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomId() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += C[Math.floor(Math.random() * C.length)];
  return id;
}

function getRoomList() {
  const list = [];
  rooms.forEach((room, id) => {
    if (room.isPublic && room.phase === 'lobby') {
      list.push({ id, hostName: room.hostName, playerCount: room.players.size, gameMode: room.gameMode || 1 });
    }
  });
  return list;
}

function getOccupiedSlots(room) {
  const slots = [];
  room.players.forEach(p => slots.push(p.slot));
  return slots;
}

// ========== API PROXY ==========
const activeApiCalls = new Map();
app.post('/api/proxy', async (req, res) => {
  const { apiUrl, apiKey, model, maxTokens, prompt, callId } = req.body;
  if (!apiUrl || !apiKey || !prompt) return res.status(400).json({ error: 'Missing fields' });
  const controller = new AbortController();
  if (callId) activeApiCalls.set(callId, controller);
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model||'gpt-3.5-turbo', max_tokens: maxTokens||65536, messages:[{role:'user',content:prompt}] }),
      signal: controller.signal
    });
    if (callId) activeApiCalls.delete(callId);
    if (!response.ok) { const e = await response.text().catch(()=>''); return res.status(response.status).json({error:`API ${response.status}: ${e.substring(0,500)}`}); }
    res.json(await response.json());
  } catch (err) {
    if (callId) activeApiCalls.delete(callId);
    if (err.name === 'AbortError') return res.status(499).json({ error: 'Aborted' });
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/abort', (req, res) => {
  const { callIds } = req.body;
  if (!callIds) return res.status(400).json({error:'missing'});
  let n = 0;
  callIds.forEach(id => { const c = activeApiCalls.get(id); if(c){c.abort();activeApiCalls.delete(id);n++;} });
  res.json({ aborted: n });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  let currentRoom = null, currentSlot = -1, playerName = '';
  socket.emit('room_list', getRoomList());

  socket.on('create_room', (data, cb) => {
    const { name, isPublic, password } = data;
    let roomId; do { roomId = generateRoomId(); } while (rooms.has(roomId));
    const room = {
      id: roomId, hostId: socket.id, hostName: name||'Host',
      isPublic: isPublic !== false, password: isPublic!==false ? null : (password||'000000'),
      phase: 'lobby', gameMode: 1, maxPlayers: 12,
      players: new Map(), slotMap: {}, gameState: null,
    };
    room.players.set(socket.id, { slot:0, name:name||'Host', ready:true });
    room.slotMap[0] = socket.id;
    rooms.set(roomId, room);
    currentRoom = roomId; currentSlot = 0; playerName = name||'Host';
    socket.join(roomId);
    cb({ success:true, roomId, slot:0, isHost:true });
    io.emit('room_list', getRoomList());
    broadcastRoomState(roomId);
  });

  socket.on('join_room', (data, cb) => {
    const { roomId, name, password } = data;
    const room = rooms.get(roomId);
    if (!room) return cb({success:false,error:'房间不存在'});
    if (room.phase !== 'lobby') return cb({success:false,error:'游戏已开始'});
    if (!room.isPublic && room.password && room.password !== password) return cb({success:false,error:'密码错误'});
    if (room.players.has(socket.id)) return cb({success:false,error:'你已在房间中'});
    let slot = -1;
    for (let i = 0; i < (room.maxPlayers||12); i++) { if (!room.slotMap[i]) { slot=i; break; } }
    if (slot === -1) return cb({success:false,error:'房间已满'});
    room.players.set(socket.id, { slot, name: name||`玩家${slot+1}`, ready:false });
    room.slotMap[slot] = socket.id;
    currentRoom = roomId; currentSlot = slot; playerName = name||`玩家${slot+1}`;
    socket.join(roomId);
    cb({ success:true, roomId, slot, isHost: room.hostId===socket.id });
    io.emit('room_list', getRoomList());
    broadcastRoomState(roomId);
  });

  socket.on('leave_room', () => leaveCurrentRoom());
  socket.on('update_player', data => {
    if (!currentRoom) return; const room = rooms.get(currentRoom); if(!room) return;
    const p = room.players.get(socket.id); if(!p) return;
    if (data.name !== undefined) { p.name = data.name; playerName = data.name; }
    if (data.ready !== undefined) p.ready = data.ready;
    broadcastRoomState(currentRoom);
  });

  socket.on('start_game', () => {
    if (!currentRoom) return; const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'playing';
    const occupiedSlots = getOccupiedSlots(room);
    io.to(currentRoom).emit('game_started', { hostId: room.hostId, occupiedSlots });
    io.emit('room_list', getRoomList());
  });

  socket.on('sync_game_state', state => {
    if (!currentRoom) return; const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.gameState = state;
    room.players.forEach((p, sid) => {
      if (sid !== socket.id) {
        io.to(sid).emit('game_state_update', buildPlayerView(state, p.slot));
      }
    });
  });

  socket.on('player_action', action => {
    if (!currentRoom) return; const room = rooms.get(currentRoom); if(!room) return;
    const p = room.players.get(socket.id); if(!p) return;
    io.to(room.hostId).emit('remote_player_action', { slot: p.slot, socketId: socket.id, ...action });
  });

  socket.on('horn_boost', () => {
    if (!currentRoom) return; const room = rooms.get(currentRoom); if(!room) return;
    io.to(room.hostId).emit('horn_boost_triggered', { fromSlot: currentSlot });
    io.to(currentRoom).emit('horn_effect', { fromSlot: currentSlot });
  });

  socket.on('game_reset', () => {
    if (!currentRoom) return; const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby'; room.gameState = null;
    io.to(currentRoom).emit('game_reset');
    io.emit('room_list', getRoomList());
    broadcastRoomState(currentRoom);
  });

  socket.on('disconnect', () => leaveCurrentRoom());

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom); if(!room){currentRoom=null;return;}
    const p = room.players.get(socket.id);
    if (p) { delete room.slotMap[p.slot]; room.players.delete(socket.id); }
    socket.leave(currentRoom);
    if (room.hostId === socket.id) {
      if (room.players.size > 0) {
        const [nid, nd] = room.players.entries().next().value;
        room.hostId = nid; room.hostName = nd.name;
        io.to(nid).emit('became_host');
      } else { rooms.delete(currentRoom); }
    }
    broadcastRoomState(currentRoom);
    io.emit('room_list', getRoomList());
    currentRoom = null; currentSlot = -1;
  }
});

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId); if(!room) return;
  const pl = [];
  room.players.forEach((p,sid) => pl.push({ slot:p.slot, name:p.name, ready:p.ready, isHost:sid===room.hostId }));
  pl.sort((a,b)=>a.slot-b.slot);
  io.to(roomId).emit('room_state', {
    players: pl, roomId: room.id, isPublic: room.isPublic, gameMode: room.gameMode,
    hostSlot: room.players.get(room.hostId)?.slot||0, phase: room.phase,
    occupiedSlots: getOccupiedSlots(room),
  });
}

function buildPlayerView(state, slot) {
  if (!state) return null;
  const myRole = state.players?.[slot]?.role || null;
  return {
    phase: state.phase, round: state.round, step: state.step,
    players: state.players?.map(p => ({
      id:p.id, name:p.name, avatar:p.avatar, alive:p.alive, canVote:p.canVote, idiotRevealed:p.idiotRevealed,
      isHuman: p.isHuman || p.isRemote,
      role: (p.id===slot || (state.revealDead && !p.alive) || state.phase==='gameOver') ? p.role : null
    })),
    mySlot: slot, myRole, myAlive: state.players?.[slot]?.alive ?? true,
    speeches: state.speeches||[], votes: state.votes||{}, voteOrder: state.voteOrder||[],
    nightResultMsg: state.nightResultMsg||'', gameResult: state.gameResult,
    lastWordsList: state.lastWordsList||[], dayVoteHistory: state.dayVoteHistory||[],
    votingActive: state.votingActive||false,
    wolfTeam: myRole==='werewolf' ? (state.players||[]).filter(p=>p.role==='werewolf'&&p.id!==slot).map(p=>({id:p.id,name:p.name,alive:p.alive})) : null,
    seerHistory: myRole==='seer' ? (state.seerHistory||[]) : null,
    witchInfo: myRole==='witch' ? { hasSave:state.witchHasSave, hasPoison:state.witchHasPoison, nightKill:state.nightKill } : null,
    pendingAction: state.pendingActions?.[slot] || null,
    nightProgressPct: state.nightProgressPct||0, nightProgressLabel: state.nightProgressLabel||'',
    speechOrder: state.speechOrder||[], currentSpeaker: state.currentSpeaker ?? null,
    log: state.log||[], showLog: state.showLog||false,
    revealDead: state.revealDead||false, enableLW: state.enableLW||false,
    apiAutoMode: state.apiAutoMode||false, dayResultMsg: state.dayResultMsg||'',
  };
}

app.get('/health', (req,res) => res.json({status:'ok', rooms:rooms.size}));
setInterval(() => { rooms.forEach((r,id) => { if(r.players.size===0) rooms.delete(id); }); }, 60000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐺 Werewolf Online on port ${PORT}`));
