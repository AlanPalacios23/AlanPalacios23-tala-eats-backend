import type { Request, Response } from 'express';
import { config } from './config.js';
import { stripe } from './stripe.js';
import { db } from './db.js';
import { webhookQueue } from './queues.js';

export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  if (!stripe || !config.STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: 'test_webhook_not_configured' });
    return;
  }
  const signature = req.header('stripe-signature');
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'signature_required' });
    return;
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, signature, config.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    res.status(400).json({ error: 'signature_invalid' });
    return;
  }
  if (event.livemode) {
    res.status(403).json({ error: 'live_event_forbidden' });
    return;
  }
  try {
    const obj = event.data.object as { id?: string };
    const receipt = await db.stripeWebhookEvent.upsert({
      where: { id: event.id },
      create: {
        id: event.id, type: event.type,
        stripeAccountId: event.account ?? null,
        objectId: typeof obj.id === 'string' ? obj.id : null,
      },
      update: { deliveryCount: { increment: 1 } },
    });
    // Every signed resend gets an independent bounded job. A terminal
    // failed BullMQ job retained in Redis must not block redelivery.
    // The PG receipt/event+financial ledger are still strictly idempotent.
    await webhookQueue.add('receipt', { eventId: event.id }, {
      jobId: 'evt-' + event.id.replaceAll(':', '-') + '-delivery-' + receipt.deliveryCount,
    });
    res.status(200).json({ received: true });
  } catch {
    res.status(500).json({ error: 'receipt_failed' });
  }
}
