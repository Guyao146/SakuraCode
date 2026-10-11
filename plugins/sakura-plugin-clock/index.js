/**
 * sakura-plugin-clock — out-of-tree example plugin.
 *
 * Drop this folder into the project `plugins/` directory (or list
 * "plugins/sakura-plugin-clock/index.js" under `bundles:` in sakura.yml)
 * and it is mounted with the rest of the composition. Plugin shape is
 * identical to builtin plugins: name / inject / apply(ctx, config).
 */

export const name = 'sakura-plugin-clock'
export const description = 'now — returns the current local time (out-of-tree example)'

export const inject = ['tools']

export function apply(ctx, config) {
  const prefix = config?.toolPrefix ?? ''
  ctx.get('tools').register({
    name: `${prefix}now`,
    description: 'Get the current local date and time (example plugin).',
    kind: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: new Date().toString() }),
  })
}
