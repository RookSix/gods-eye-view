import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { installCustomerPointLayer } from './layers/customerPoints/index.js';
import './layers/customerPoints/styles.css';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application
  .start()
  .then((components) => {
    const customerPointLayer = installCustomerPointLayer(components.scene.viewer);
    window.__gevCustomerPointLayer = customerPointLayer;
    const unsubscribe = application.subscribe((state) => {
      if (state.status === 'destroying' || state.status === 'destroyed') {
        unsubscribe();
        if (window.__gevCustomerPointLayer === customerPointLayer)
          delete window.__gevCustomerPointLayer;
        customerPointLayer.destroy();
      }
    });
  })
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector('#loading-screen .loader-status');
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  });

export { application };
