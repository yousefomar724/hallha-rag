import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

/** Better Auth may store userId as string or ObjectId depending on adapter transforms. */
export async function findMemberByUserId(db: Db, userId: string): Promise<Record<string, unknown> | null> {
  const clauses: Record<string, unknown>[] = [{ userId }];
  if (ObjectId.isValid(userId)) {
    clauses.push({ userId: new ObjectId(userId) });
  }
  return db.collection('member').findOne({ $or: clauses });
}

export function readOrganizationIdFromMember(member: Record<string, unknown> | null): string | null {
  if (!member) return null;
  const raw = member.organizationId;
  if (typeof raw === 'string') return raw;
  if (raw instanceof ObjectId) return raw.toHexString();
  return null;
}
