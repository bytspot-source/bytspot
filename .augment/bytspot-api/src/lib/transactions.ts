import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { db } from './db';

/** Postgres refused to serialize (P2034), or a unique constraint caught the
 *  same race first (P2002). Both mean: someone else got there, try again or
 *  tell the caller.
 *
 *  A serialization failure raised inside a raw query arrives as P2010 with
 *  Postgres' own 40001 buried in it rather than as P2034, so it is recognised
 *  here too. Without this a `SELECT ... FOR UPDATE` losing a race would be
 *  reported to the caller as an unhandled raw-query error instead of retried.
 */
export function isSerializationConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: string }).code ?? '';
  if (['P2002', 'P2034'].includes(code)) return true;
  if (code !== 'P2010') return false;
  const meta = (error as { meta?: { code?: string } }).meta;
  return meta?.code === '40001' || String((error as { message?: string }).message ?? '').includes('40001');
}

/** A transaction alone is atomic, not isolated: under Postgres' default READ
 *  COMMITTED two callers can both read a total, both decide there is room, and
 *  both write. Anything that reads a limit and then writes against it has to
 *  say Serializable out loud. */
export async function serializableTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, conflictMessage: string): Promise<T> {
  try {
    return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSerializationConflict(error)) throw new TRPCError({ code: 'CONFLICT', message: conflictMessage });
    throw error;
  }
}

/** As above, but retried once before giving up. For work where losing the race
 *  is not the member's fault and there is nothing useful for them to do about
 *  it — a check-in should not fail because someone else checked in. */
export async function serializableTransactionWithRetry<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, conflictMessage: string): Promise<T> {
  try {
    return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (!isSerializationConflict(error)) throw error;
    return serializableTransaction(operation, conflictMessage);
  }
}
