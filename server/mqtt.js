import mqtt from 'mqtt';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { expire, get, run, settle, transaction, Rule } from './db.js';

export const signature = (key, ...fields) =>
  createHmac('sha256', key).update(fields.join('|')).digest('hex');

export function bridge(db, config, changed) {
  const topic = config.MQTT_PREFIX || 'bancofeira/v1';
  const client = config.MQTT_URL ? mqtt.connect(config.MQTT_URL, {
    username: config.MQTT_USER || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2500, queueQoSZero: false
  }) : null;
  let ready = false;
  const send = (device, op) => {
    if (!ready) return;
    const expires = String(Math.floor(op.expires / 1000));
    client.publish(topic + '/' + device.id + '/arm', JSON.stringify({
      op: op.id, expires, sig: signature(device.key, 'arm', device.id, op.id, expires)
    }), { qos: 1 });
  };
  async function receive(id, event, retained = false) {
    if (retained || !event || typeof event !== 'object') return;
    const { type, nonce, op = '', card = '', sig } = event;
    if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) return;
    if (type === 'hello' ? (op !== '' || card !== '') :
      (type !== 'tap' || !/^[a-f0-9-]{36}$/.test(op) || !/^(?:[A-F0-9]{8}|[A-F0-9]{14}|[A-F0-9]{20})$/.test(card))) return;
    const device = await get(db, 'SELECT * FROM devices WHERE id=?', id);
    if (!device || !timingSafeEqual(Buffer.from(sig, 'hex'),
      Buffer.from(signature(device.key, type, id, nonce, op, card), 'hex'))) return;
    const active = await transaction(db, async db => {
      await expire(db);
      await run(db, 'UPDATE devices SET seen=? WHERE id=?', Date.now(), id);
      const current = await get(db, "SELECT * FROM operations WHERE device=? AND status='pending'", id);
      if (type === 'hello') return current;
      if (!current || current.id !== op) return;
      const event = await run(db, 'INSERT INTO tap_events VALUES (?,?,?) ON CONFLICT DO NOTHING', id, nonce, Date.now());
      if (!event.changes) return;
      await run(db, 'DELETE FROM tap_events WHERE created<?', Date.now() - 86400000);
      try {
        if (current.kind === 'card') {
          const owner = await get(db, 'SELECT id FROM accounts WHERE card=?', card);
          if (owner && owner.id !== current.owner) throw new Rule('Cartão já vinculado a outra conta.');
          await run(db, 'UPDATE accounts SET card=? WHERE id=?', card, current.owner);
          await run(db, "UPDATE operations SET status='linked',detail=NULL WHERE id=?", current.id);
        } else {
          const payer = await get(db, "SELECT id FROM accounts WHERE card=? AND role='student'", card);
          if (!payer) throw new Rule('Cartão sem vínculo. Tente outro cartão ou gere um Pix.');
          await settle(db, current, payer.id, 'rfid');
        }
      } catch (error) {
        if (!(error instanceof Rule)) throw error;
        await run(db, 'UPDATE operations SET detail=? WHERE id=?', error.message, current.id);
      }
    });
    if (type === 'hello' && ready) {
      const time = String(Math.floor(Date.now() / 1000));
      client.publish(topic + '/' + device.id + '/status', JSON.stringify({
        nonce, time, sig: signature(device.key, 'status', device.id, nonce, time)
      }), { qos: 1 });
    }
    if (active) send(device, active);
    if (type === 'tap' || device.seen < Date.now() - 25000) changed();
  }
  client?.on('connect', () => {
    client.subscribe(topic + '/+/event', { qos: 1 }, (error, grants) => {
      ready = !error && grants?.[0]?.qos < 128;
      console.log(ready ? 'MQTT conectado.' : 'MQTT: assinatura recusada pelo broker.');
      changed();
    });
  });
  client?.on('close', () => { ready = false; changed(); });
  client?.on('error', error => console.warn('MQTT:', error.message));
  client?.on('message', async (path, buffer, packet) => {
    if (buffer.length > 1024) return;
    try { await receive(path.split('/').at(-2), JSON.parse(buffer), packet.retain); }
    catch (error) { if (!(error instanceof SyntaxError)) console.error('Falha ao processar evento RFID:', error); }
  });
  return {
    ready: () => ready,
    arm: async op => send(await get(db, 'SELECT * FROM devices WHERE id=?', op.device), op),
    close: () => client?.end(true)
  };
}
