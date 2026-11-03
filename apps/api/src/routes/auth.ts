import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken } from './organizations.js';
import { ApiFailure } from '../errors.js';
import { INVALID_CREDENTIALS_BODY, type AuthGuard } from '../security/auth-guard.js';

export type SessionResult = { accessToken: string; refreshToken: string | null; user: { userId: string; email: string; displayName: string | null } };
export type AuthGateway = {
  sendAccountEmail?(email:string,type:'recovery'|'signup'):Promise<void>;
  resetPassword?(token:string,password:string):Promise<{password_changed:true;session_cleanup_pending:boolean}>;
  assertSession?(token:string):Promise<void>;
  listSessions?(token:string,cursor?:string):Promise<unknown>;
  revokeSessions?(token:string,sessionId:string|null):Promise<{current_revoked:boolean}>;
  logout?(token:string):Promise<void>;
  signIn(email: string, password: string): Promise<SessionResult>;
  signUp?(email: string, password: string, displayName: string): Promise<SessionResult | null>;
  refresh?(token:string):Promise<SessionResult>;
  getUser?(token:string):Promise<SessionResult['user']>;
};

const LoginSchema = z.object({ email: z.email(), password: z.string().min(1) });

const SignUpSchema = z.object({ email: z.email(), password: z.string().min(8).max(200), display_name: z.string().trim().min(1).max(100) }).strict();
const sessionBody = (session: SessionResult) => ({ access_token: session.accessToken, refresh_token: session.refreshToken, user: { user_id: session.user.userId, email: session.user.email, display_name: session.user.displayName } });

/** guard 가 있으면 로그인·회원가입·갱신에 시도 제한(SEC-03)을 적용한다. */
export async function registerAuthRoutes(app: FastifyInstance, auth: AuthGateway, guard?: AuthGuard): Promise<void> {
  app.post('/api/v1/auth/logout',async request=>{if(!auth.logout)throw new ApiFailure(503,'Authentication unavailable');await auth.logout(bearerToken(request));return {logged_out:true};});
  app.post('/api/v1/auth/email',async request=>{
    const input=z.object({email:z.email().max(254),type:z.enum(['recovery','signup'])}).strict().safeParse(request.body);
    if(!input.success) throw new ApiFailure(422,'Invalid email request');
    guard?.attemptAccountEmail(request.ip,input.data.email);
    if(!auth.sendAccountEmail)throw new ApiFailure(503,'Email delivery unavailable');
    try{await auth.sendAccountEmail(input.data.email,input.data.type);}
    catch(error){
      if(!(error instanceof ApiFailure&&error.extra.code==='email_provider_failure'))throw error;
      // Auth can skip delivery for absent/confirmed accounts. Exposing delivery errors
      // only for existing accounts would turn SMTP outages into an account oracle.
      request.log.warn({event:'account_email_delivery_unconfirmed'},'Account email provider delivery could not be confirmed');
    }
    return {message:'입력한 이메일로 진행할 수 있는 경우 안내 메일을 보냅니다.',delivery_confirmed:false};
  });
  app.post('/api/v1/auth/password',async request=>{
    const input=z.object({password:z.string().min(8).max(200)}).strict().safeParse(request.body);
    if(!input.success)throw new ApiFailure(422,'Invalid password');
    if(!auth.resetPassword)throw new ApiFailure(503,'Authentication unavailable');
    return auth.resetPassword(bearerToken(request),input.data.password);
  });
  app.get('/api/v1/auth/sessions',async request=>{
    const input=z.object({cursor:z.uuid().optional()}).strict().safeParse(request.query);
    if(!input.success)throw new ApiFailure(422,'Invalid cursor');
    if(!auth.listSessions)throw new ApiFailure(503,'Authentication unavailable');return auth.listSessions(bearerToken(request),input.data.cursor);
  });
  app.post('/api/v1/auth/sessions/revoke',async request=>{
    const input=z.object({session_id:z.uuid().nullable()}).strict().safeParse(request.body);
    if(!input.success)throw new ApiFailure(422,'Invalid session');
    if(!auth.revokeSessions)throw new ApiFailure(503,'Authentication unavailable');return auth.revokeSessions(bearerToken(request),input.data.session_id);
  });
  app.post('/api/v1/auth/signup', async (request, reply) => {
    const input = SignUpSchema.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid sign-up input');
    if (!auth.signUp) throw new ApiFailure(503, 'Authentication unavailable');
    guard?.attemptSignup(request.ip, input.data.email);
    const session = await auth.signUp(input.data.email, input.data.password, input.data.display_name);
    // 이메일 확인이 필요한 계정은 세션 없이 안내만 돌려준다.
    return reply.code(200).send(session ? { ...sessionBody(session), email_confirmation_required: false } : { email_confirmation_required: true });
  });
  app.post('/api/v1/auth/refresh', async request => {
    const input = z.object({refresh_token:z.string().min(1)}).safeParse(request.body);
    if (!input.success) throw new ApiFailure(422,'Invalid refresh token');
    if (!auth.refresh) throw new ApiFailure(503,'Authentication unavailable');
    guard?.attemptRefresh(request.ip);
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
    const startedAt = guard?.now() ?? 0;
    const input = LoginSchema.safeParse(request.body);
    if (!input.success) return reply.code(422).send({ code: 'validation_error', message: '이메일과 비밀번호를 확인해 주세요.' });
    const { email, password } = input.data;
    guard?.beforeLogin(request.ip, email);
    try {
      const session = await auth.signIn(email, password);
      guard?.loginSucceeded(request.ip, email);
      return sessionBody(session);
    } catch (error) {
      // 인증 서비스 장애(503 등)는 자격 증명 실패가 아니므로 세지 않고 그대로 알린다.
      if (error instanceof ApiFailure && error.status !== 401) throw error;
      guard?.loginFailed(request.ip, email);
      await guard?.padFailure(startedAt);
      // 존재하지 않는 이메일과 틀린 비밀번호는 같은 응답이다.
      return reply.code(401).send({ ...INVALID_CREDENTIALS_BODY, requestId: request.id });
    }
  });
}
