import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Explicit audit only. *.audit.tsx files are excluded from the normal test pattern.
export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['audit/*.audit.tsx'] } });
