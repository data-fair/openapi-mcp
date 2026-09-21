import neostandard from 'neostandard'
import dfLibRecommended from '@data-fair/lib-utils/eslint/recommended.js'

export default [
  { ignores: ['dist/*', 'node_modules/*'] },
  ...dfLibRecommended,
  ...neostandard({ ts: true })
]
