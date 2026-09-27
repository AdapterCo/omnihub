import { isRegistrationEnabled } from '@/lib/auth/service';
import { mailConfigProblems } from '@/lib/mail';

export const dynamic = 'force-dynamic';

// O que a tela de entrada pode oferecer neste servidor (sem expor a configuração em si).
export async function GET() {
    return Response.json(
        { registrationEnabled: isRegistrationEnabled(), passwordRecovery: mailConfigProblems().length === 0 },
        { headers: { 'Cache-Control': 'no-store' } },
    );
}
