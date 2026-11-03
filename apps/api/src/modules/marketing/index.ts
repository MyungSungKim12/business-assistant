import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {OrgAccess} from '../catalog/routes.js';
import {createMarketingGateway} from './gateway.js';
import {registerMarketingRoutes} from './routes.js';
export function registerMarketingModule(app:FastifyInstance,organizations:OrgAccess|undefined,config:ServerConfig,fetcher:typeof fetch=fetch){registerMarketingRoutes(app,organizations,createMarketingGateway(config,fetcher));}
export {createMarketingGateway,type MarketingGateway} from './gateway.js';
export {registerMarketingRoutes} from './routes.js';
