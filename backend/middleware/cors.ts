import { cors } from '@elysiajs/cors';

/**
 * CORS Middleware Configuration
 * Single port setup — frontend and backend share the same origin.
 */
const port = process.env.PORT || '9141';
const host = process.env.HOST || 'localhost';
export const corsMiddleware = cors({
	origin: `http://${host}:${port}`,
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization'],
	exposeHeaders: ['Content-Type']
});
