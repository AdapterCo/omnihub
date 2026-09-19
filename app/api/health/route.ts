import { database } from '@/db/database';
import { checkHealth } from '@/lib/health';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const result = await checkHealth(database());
        if (!result.ok) logger.error('health.failed', { checks: result.checks });
        return Response.json({ status: result.status, checks: result.checks, uptimeSeconds: result.uptimeSeconds }, { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        logger.error('health.failed', { error });
        return Response.json({ status: 'error' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
