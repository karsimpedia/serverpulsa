// api/controllers/callback.js
import prisma from '../prisma.js';
import { finalizeFailed, finalizeSuccess } from '../lib/finalize.js';

export async function supplierCallback(req, res) {
  try {
    const { ref, status, message, ...rest } = req.body || {};
    if (!ref || !status) return res.status(400).json({ error: 'ref & status wajib' });

    const trx = await prisma.transaction.findFirst({ where: { invoiceId: ref } });
    if (!trx) return res.json({ ok: true, skip: 'trx not found' });

    if (trx.status !== 'PENDING' && trx.status !== 'PROCESSING') {
      return res.json({ ok: true, skip: 'already-final' });
    }

    const S = String(status).toUpperCase();
    if (S === 'SUCCESS') {
      await finalizeSuccess(trx.id, { message, supplierResult: { status: S, ...rest } });
    } else if (['FAILED','CANCELED','EXPIRED'].includes(S)) {
      await finalizeFailed(trx.id, { message, supplierResult: { status: S, ...rest } });
    } else {
      await prisma.transaction.update({
        where: { id: trx.id },
        data: { status: 'PROCESSING', message: message || 'PROCESSING', supplierResult: { status: S, ...rest } }
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
