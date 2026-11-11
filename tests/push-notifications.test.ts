import { describe, expect, it } from 'vitest'
import { pushPermissionFallback } from '../src/lib/push-notifications'

describe('browser push permission fallback', () => {
  it('keeps in-app notifications available when permission is denied', () => {
    expect(pushPermissionFallback('denied')).toContain('permission was denied')
    expect(pushPermissionFallback('denied')).toContain('in-app notifications')
  })

  it('keeps in-app notifications available when the prompt is dismissed', () => {
    expect(pushPermissionFallback('default')).toContain('permission was not granted')
    expect(pushPermissionFallback('default')).toContain('in-app notifications')
  })
})
