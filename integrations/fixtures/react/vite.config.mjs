import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import componentIdentity from '@ui-parity/component-identity/react';

export default defineConfig({
  plugins: [react({ babel: { plugins: [[componentIdentity, {
    onDiagnostic(event) {
      if (event.status === 'skipped') console.info(`${event.component} skipped (${event.reason})`);
    }
  }]] } })]
});
