const linkKey = /^(?:p1\.[1-9]\d{0,12}\.)?[a-f0-9]{64}$/;
export function createAccessStore(storage, randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')) {
  const prefix = 'first-screen:access:v1:';
  const memory = new Map();
  let persistent=Boolean(storage);
  function read(key) {
    let text=memory.get(key)||'null';
    try { text=storage?.getItem(prefix+key)||text; } catch {}
    try { return JSON.parse(text); } catch { return null; }
  }
  function write(key, value) {
    const text = JSON.stringify(value); memory.set(key, text);
    try { storage?.setItem(prefix + key, text);if(storage && storage.getItem(prefix+key)!==text)persistent=false; } catch { persistent=false; }
  }
  function remove(key) { memory.delete(key); try { storage?.removeItem(prefix + key); } catch {} }
  function registration(group, student, fresh = false) {
    const key = 'registration:' + group + ':' + student;
    let entry = read(key);
    if (!entry || (fresh && entry.mode !== 'new-start')) {
      entry = {group, student, registrationKey: randomKey(), mode: fresh ? 'new-start' : 'first'};
      write(key, entry);
    }
    write('pending', entry);
    return entry;
  }
  function remember(user, key) {
    if (!user || !linkKey.test(key || '')) return;
    const account = {user, key};
    write('account:' + user.id, account);
    write('last', account);
    const pending = read('pending');
    if (pending && user.rosterId === pending.student) write('selection:' + pending.group + ':' + pending.student, {accountId:user.id});
    remove('pending');
  }
  function valid(account) { return account?.user?.id && linkKey.test(account.key || '') ? account : null; }
  return {
    registration, remember,
    isPersistent: () => persistent,
    last: () => valid(read('last')),
    selected: (group, student) => valid(read('account:' + read('selection:' + group + ':' + student)?.accountId)),
    pending: () => read('pending'),
    signedOut() { remove('last'); remove('pending'); },
    forget(account) {
      if (read('last')?.key === account.key) remove('last');
      remove('account:' + account.user.id);
    },
  };
}
