// Service worker for the portal's optional Web Push notifications
// ("Enable Notifications" button, portal.js). Only ever registered when
// the page is already loaded over HTTPS (setup/nginx.conf's LAN-facing
// 8443 port) - service worker registration itself fails outright from a
// plain-HTTP page (insecure context), so there's no separate check needed
// here for that.
self.addEventListener('push', (event) => {
  let data = { title: 'ZenFi WiFi', body: 'You have a new notification.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/portal/assets/img/logo-icon.png',
      badge: '/portal/assets/img/logo-icon.png',
      tag: 'zenfi-session', // replaces any earlier notification instead of stacking
      renotify: true
    })
  );
});

// Tapping the notification brings an existing portal tab to the front
// instead of always opening a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/portal');
    })
  );
});
