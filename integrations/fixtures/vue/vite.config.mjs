import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vueComponentIdentity } from '@ui-parity/component-identity/vue';

const identity = vueComponentIdentity({
  onDiagnostic(event) {
    if (event.status === 'skipped') console.info(`${event.component} skipped (${event.reason})`);
  }
});
export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { nodeTransforms: identity.nodeTransforms } } })]
});
