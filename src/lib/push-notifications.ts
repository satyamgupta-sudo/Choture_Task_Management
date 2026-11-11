export function pushPermissionFallback(permission: NotificationPermission): string {
  return permission === 'denied'
    ? 'Browser push permission was denied. You will continue to receive in-app notifications.'
    : 'Push permission was not granted. You will continue to receive in-app notifications.'
}
