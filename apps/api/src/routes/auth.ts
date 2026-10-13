import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './organizations.js';
import { ApiFailure } from '../errors.js';

export type SessionResult = { accessToken: string; refreshToken: string | null; user: { userId: string; email: string; displayName: string | null } };
export type AuthGateway = {
  signIn(email: string, password: string): Promise<SessionResult>;
  refresh?(token:string):Promise<SessionResult>;
  getUser?(token:string):Promise<SessionResult['user']>;
};

const LoginSchema = z.object({ email: z.email(), password: z.string().min(1) });

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthGateway): Promise<void> {
  app.post('/api/v1/auth/refresh', async request => {
    const input = z.object({refresh_token:z.string().min(1)}).safeParse(request.body);
    if (!input.success) throw new ApiFailure(422,'Invalid refresh token');
    if (!auth.refresh) throw new ApiFailure(503,'Authentication unavailable');
    const session = await auth.refresh(input.data.refresh_token);
    return {access_token:session.accessToken,refresh_token:session.refreshToken,user:{user_id:session.user.userId,email:session.user.email,display_name:session.user.displayName}};
  });
  app.get('/api/v1/me', async request => {
    const token = bearerToken(request);
    if (!auth.getUser) throw new ApiFailure(503,'Authentication unavailable');
    const user = await auth.getUser(token);
    return {user_id:user.userId,email:user.email,display_name:user.displayName};
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = LoginSchema.safeParse(request.body);
    if (!input.success) return reply.code(422).send({ code: 'validation_error', message: '이메일과 비밀번호를 확인해 주세요.' });
    try {
      const session = await auth.signIn(input.data.email, input.data.password);
      return { access_token: session.accessToken, refresh_token: session.refreshToken, user: { user_id: session.user.userId, email: session.user.email, display_name: session.user.displayName } };
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      return reply.code(401).send({ code: 'invalid_credentials', message: '이메일과 비밀번호를 확인해 주세요.' });
    }
  });
}
