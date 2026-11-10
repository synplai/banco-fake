import mqtt from 'mqtt';
import { createECDH, createHmac, timingSafeEqual } from 'node:crypto';
import { expire, get, run, settle, transaction, Rule } from './db.js';

export const signature = (key, ...fields) =>
  createHmac('sha256', key).update(fields.join('|')).digest('hex');
export const deviceOnlineSince = () => Date.now() - 25000;

export async function bridge(db, config, changed) {
  const topic = config.MQTT_PREFIX || 'bancofeira/v1';
  const exchange = createECDH('prime256v1');
  if (config.MQTT_URL) {
    await transaction(db, async db => {
      const saved = await get(db, 'SELECT key FROM device_exchange WHERE id=1');
      if (saved) exchange.setPrivateKey(saved.key, 'hex');
      else {
        exchange.generateKeys();
        await run(db, 'INSERT INTO device_exchange VALUES (1,?)', exchange.getPrivateKey('hex'));
      }
    });
  }
  const client = config.MQTT_URL ? mqtt.connect(config.MQTT_URL, {
    username: config.MQTT_USER || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2500, queueQoSZero: false
  }) : null;
  let ready = false;
  const send = (device, op) => {
    if (!ready || !device) return;
    const expires = String(Math.floor(op.expires / 1000));
    client.publish(topic + '/' + device.id + '/arm', JSON.stringify({
      op: op.id, expires, sig: signature(device.key, 'arm', device.id, op.id, expires)
    }), { qos: 1 });
  };
  async function receive(id, event, retained = false) {
    if (retained || !event || typeof event !== 'object') return;
    const { type, nonce, op = '', card = '', sig, pub } = event;
    if (typeof nonce !== 'string' || typeof sig !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) return;
    if (type === 'hello' ? (op !== '' || card !== '') :
      (type !== 'tap' || !/^[a-f0-9-]{36}$/.test(op) || !/^(?:[A-F0-9]{8}|[A-F0-9]{14}|[A-F0-9]{20})$/.test(card))) return;
    const valid = key => timingSafeEqual(Buffer.from(sig, 'hex'),
      Buffer.from(signature(key, type, id, nonce, op, card), 'hex'));
    const result = await transaction(db, async db => {
      const device = await get(db, 'SELECT * FROM devices WHERE id=?', id);
      if (!device || !valid(device.key)) {
        if (type !== 'hello' || !/^\d{4}$/.test(id) || typeof pub !== 'string' || !/^04[a-f0-9]{128}$/.test(pub)) return;
        let key;
        try {
          key = signature(exchange.computeSecret(pub, 'hex'), 'device', topic, id);
        } catch { return; }
        if (device && device.key !== key) return;
        if (!valid(key)) return { offer: exchange.getPublicKey('hex') };
        if (device) return;
        const since = deviceOnlineSince();
        await run(db, 'DELETE FROM device_discovery WHERE seen<?', since);
        const known = await get(db, 'SELECT 1 FROM device_discovery WHERE id=? AND key=?', id, key);
        await run(db, `INSERT INTO device_discovery VALUES (?,?,?)
          ON CONFLICT(id,key) DO UPDATE SET seen=excluded.seen`, id, key, Date.now());
        return { candidate: { id, key }, discovered: !known };
      }
      await expire(db);
      await run(db, 'UPDATE devices SET seen=? WHERE id=?', Date.now(), id);
      const current = await get(db, "SELECT * FROM operations WHERE device=? AND status='pending'", id);
      if (type === 'hello') return { device, active: current };
      if (!current || current.id !== op) return { device };
      const event = await run(db, 'INSERT INTO tap_events VALUES (?,?,?) ON CONFLICT DO NOTHING', id, nonce, Date.now());
      if (!event.changes) return { device };
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
      return { device };
    });
    if (!result) return;
    if (result.offer) {
      if (ready) client.publish(topic + '/' + id + '/status', JSON.stringify({ nonce, pub: result.offer }), { qos: 1 });
      return;
    }
    const { device = result.candidate, active } = result;
    if (type === 'hello' && ready) {
      const time = String(Math.floor(Date.now() / 1000));
      client.publish(topic + '/' + device.id + '/status', JSON.stringify({
        nonce, time, sig: signature(device.key, 'status', device.id, nonce, time)
      }), { qos: 1 });
    }
    if (active) send(device, active);
    if (result.discovered || type === 'tap' || device.seen < deviceOnlineSince()) changed();
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
