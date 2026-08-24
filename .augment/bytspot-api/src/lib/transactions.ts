import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { db } from './db';

/** Postgres refused to serialize (P2034), or a unique constraint caught the
 *  same race first (P2002). Both mean: someone else got there, try again or
 *  tell the caller. */
export function isSerializationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes((error as { code?: string }).code ?? ''));
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
