'use strict';
/*
 * server/discovery.js — LAN presence responder.
 *
 * Answers a UDP broadcast probe ("MELLOW_DISCOVER_V1") on `port` so desktop
 * and (later) mobile clients can find this server without typing an address.
 * Same-subnet only; clients on a VPN should enter the address manually.
 */

const dgram = require('dgram');

const PROBE = Buffer.from('MELLOW_DISCOVER_V1');

function start({ port, servicePort, https, name = 'Mellow', logger = console } = {}) {
  if (!port || !servicePort) throw new Error('discovery: port and servicePort are required');
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (msg, rinfo) => {
    if (!msg.equals(PROBE)) return;
    const answer = Buffer.from(
      JSON.stringify({ service: 'mellow', name, port: Number(servicePort), https: !!https })
    );
    socket.send(answer, rinfo.port, rinfo.address, (err) => {
      if (err) logger.warn('Discovery reply failed:', err.message);
    });
  });

  socket.on('error', (err) => {
    logger.warn('Discovery socket error:', err.message);
  });

  socket.bind(port, '0.0.0.0', () => {
    try {
      socket.setBroadcast(true);
    } catch (_) {}
  });

  return {
    socket,
    stop() {
      try {
        socket.close();
      } catch (_) {}
    }
  };
}

module.exports = { start, PROBE };
