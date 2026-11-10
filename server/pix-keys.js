import { requireRule as check } from './db.js';

export const registeredTypes = ['random', 'email', 'phone', 'cpf'];

export function normalizeKey(type, input) {
  if (typeof input !== 'string' || input.length > 150) return null;
  const value = input.trim().toLowerCase();
  if (type === 'username') {
    const username = value.replace(/^@/, '');
    return /^[a-z0-9._-]{3,40}$/.test(username) ? username : null;
  }
  if (type === 'email') return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value) ? value : null;
  if (type === 'random') return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : null;
  if (type === 'cnpj') {
    const cnpj = value.toUpperCase().replace(/[./\s-]/g, '');
    return /^[A-Z0-9]{12}\d{2}$/.test(cnpj) ? cnpj : null;
  }
  if (type === 'cpf') {
    const cpf = value.replace(/[.\s-]/g, '');
    return /^\d{11}$/.test(cpf) ? cpf : null;
  }
  if (type === 'phone') {
    const number = value.replace(/[()\s-]/g, '').replace(/^\+55/, '');
    const local = /^55\d{11}$/.test(number) ? number.slice(2) : number;
    return /^[1-9]\d9\d{8}$/.test(local) ? '+55' + local : null;
  }
  return null;
}

export function keyCandidates(type, input) {
  check(typeof input === 'string' && input.length <= 150, 'Informe uma chave Pix válida.');
  const value = input.trim();
  let types = [type];
  if (type === 'auto') {
    if (value.startsWith('@')) types = ['username'];
    else if (value.includes('@')) types = ['email'];
    else if (normalizeKey('random', value)) types = ['random', 'username'];
    else if (value.startsWith('+') || value.includes('(')) types = ['phone'];
    else if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(value)) types = ['cpf'];
    else if (value.includes('/')) types = ['cnpj'];
    else types = ['username', 'cnpj', 'cpf', 'phone'];
  }
  const candidates = types.map(kind => [kind, normalizeKey(kind, value)]).filter(([, key]) => key);
  check(candidates.length, 'Informe uma chave Pix válida.');
  return candidates;
}
