import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8000';

  return {
    plugins: [react()],
    clearScreen: false,
    build: { target: 'chrome105' },
    server: {
      port: 1420,
      strictPort: true,
      proxy: {
        // 관리자 API는 별도 서버(기본 8001)다. 더 구체적인 경로를 먼저 둔다.
        '/api/v1/admin': {
          target: env.VITE_ADMIN_API_PROXY_TARGET?.trim() || 'http://127.0.0.1:8001',
          changeOrigin: true,
        },
        '/api/v1': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: true,
    },
  };
});
