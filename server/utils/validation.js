const { z } = require('zod');

// Same MAC shape coin.js's own isValidMac() already enforces - kept as a
// shared schema so new routes don't reinvent (or skip) it.
const macAddress = z.string().trim().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'Invalid MAC address');

// Express middleware factory: validates req.body against a zod schema,
// replaces req.body with the parsed/coerced result on success, responds
// 400 with a plain-language message on failure. Fails closed - malformed
// input never reaches route logic.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      return res.status(400).json({
        success: false,
        message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request body',
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { z, macAddress, validateBody };
