'use strict';
const db = require('./db.js');

function loadReadState() {
  return db.loadReadState();
}

function saveReadState(state) {
  db.saveReadState(state);
}

function markRead(state, userId, channelId, timestamp) {
  state[userId] = state[userId] || {};
  state[userId][channelId] = timestamp;
}

function getLastRead(state, userId, channelId) {
  const u = state[userId];
  return (u && u[channelId]) || 0;
}

function isUnread(message, lastRead, userId) {
  return message.userId !== userId && message.timestamp > lastRead;
}

function computeUnreadCounts(channels, readState, userId) {
  const userReads = (readState && readState[userId]) || {};
  const counts = {};
  if (!Array.isArray(channels)) return counts;

  channels.forEach(ch => {
    if (ch.type === 'dm') {
      if (!ch.members || !ch.members.includes(userId)) return;
    }
    const lastRead = userReads[ch.id] || 0;
    let unread = 0;
    if (ch.messages && ch.messages.length > 0) {
      ch.messages.forEach(m => {
        if (m.userId !== userId && m.timestamp > lastRead) {
          unread++;
        }
      });
    }
    counts[ch.id] = unread;
  });
  return counts;
}

module.exports = { loadReadState, saveReadState, markRead, getLastRead, isUnread, computeUnreadCounts };