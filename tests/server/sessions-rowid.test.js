import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// Same-millisecond created_at ties: ordering and truncation must follow
// insertion order (rowid), not the millisecond timestamp.
describe('sessions same-millisecond ordering/truncation', () => {
  let sessionsRepo;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-sess-'));
    process.env.SESSIONS_DB_PATH = path.join(tempDir, 'sessions.db');
    sessionsRepo = require('../../src/sessions');
    sessionsRepo._resetForTest();
    // Force every message into the same millisecond
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionsRepo._resetForTest();
    delete process.env.SESSIONS_DB_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getMessages keeps insertion order when created_at ties', () => {
    const s = sessionsRepo.createSession({ name: 't' });
    sessionsRepo.addMessage(s.id, { role: 'user', content: 'm1' });
    sessionsRepo.addMessage(s.id, { role: 'assistant', content: 'm2' });
    sessionsRepo.addMessage(s.id, { role: 'user', content: 'm3' });
    const msgs = sessionsRepo.getMessages(s.id);
    expect(msgs.map(m => m.content)).toEqual(['m1', 'm2', 'm3']);
  });

  it('truncateMessagesFrom deletes only the target and later messages on same-ms', () => {
    const s = sessionsRepo.createSession({ name: 't' });
    sessionsRepo.addMessage(s.id, { role: 'user', content: 'm1' });
    const m2 = sessionsRepo.addMessage(s.id, { role: 'assistant', content: 'm2' });
    sessionsRepo.addMessage(s.id, { role: 'user', content: 'm3' });

    const deleted = sessionsRepo.truncateMessagesFrom(s.id, m2.id);
    expect(deleted).toBe(2);
    const msgs = sessionsRepo.getMessages(s.id);
    expect(msgs.map(m => m.content)).toEqual(['m1']);
  });

  it('truncateMessagesFrom on the first message empties the session (same-ms)', () => {
    const s = sessionsRepo.createSession({ name: 't' });
    const m1 = sessionsRepo.addMessage(s.id, { role: 'user', content: 'm1' });
    sessionsRepo.addMessage(s.id, { role: 'assistant', content: 'm2' });

    const deleted = sessionsRepo.truncateMessagesFrom(s.id, m1.id);
    expect(deleted).toBe(2);
    expect(sessionsRepo.getMessages(s.id)).toEqual([]);
  });
});
