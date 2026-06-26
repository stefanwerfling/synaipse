export * from './Types.js';
export * from './Schemas.js';
export * from './Config.js';
export * from './Errors.js';
export * from './Adapter.js';
export * from './Chat.js';
export * from './TypedLinks.js';

// TokenHash and PasswordHash are deliberately NOT in the barrel: they
// import node:crypto, and pulling them into the browser bundle (web
// frontend imports @synaipse/core for types) makes vite reject the
// build. Server-side consumers import the subpaths directly:
//   import {generateToken} from '@synaipse/core/token-hash';
//   import {generatePasswordHash} from '@synaipse/core/password-hash';