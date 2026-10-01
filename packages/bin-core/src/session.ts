import { randomUUID } from 'node:crypto';
import type { Message, Session } from './types.js';

/**
 * 会话管理器。
 * M0 阶段会话只存在内存里，服务重启即丢失——历史消息不是信息中枢的"真相来源"，
 * 真正的记录落在 entries 表，所以这里不需要持久化。
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  create(name?: string): Session {
    return this.createWithId(randomUUID(), name);
  }

  private createWithId(id: string, name?: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id,
      name: name ?? '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id?: string): Session {
    if (id) {
      const existing = this.sessions.get(id);
      if (existing) return existing;
      return this.createWithId(id);
    }
    return this.create();
  }

  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session 不存在: ${sessionId}`);
    }
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
  }

  getMessages(sessionId: string): Message[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session 不存在: ${sessionId}`);
    }
    return session.messages;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  getAll(): Session[] {
    return Array.from(this.sessions.values());
  }
}