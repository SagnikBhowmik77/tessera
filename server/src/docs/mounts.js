import express from 'express';

// Express 5 forgets where a router was mounted once it is mounted. This remembers it on each layer
// (layer.mountPath), so the OpenAPI document can be built from the real routes (E15). Imported
// first by app.js; it changes nothing about how requests are handled.
const proto = express.Router.prototype;
if (!proto.use.recordsMounts) {
  const use = proto.use;
  const recording = function use_(...args) {
    const before = this.stack.length;
    const out = use.apply(this, args);
    const path = typeof args[0] === 'string' ? args[0] : '/';
    for (const layer of this.stack.slice(before)) layer.mountPath = path;
    return out;
  };
  recording.recordsMounts = true;
  proto.use = recording;
}
