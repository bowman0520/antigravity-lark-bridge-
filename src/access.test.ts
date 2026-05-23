import { isAdmin, isChatAllowed, isUserAllowed } from './access';

const config: any = {
  access: {
    allowedUsers: [],
    allowedChats: [],
    admins: [],
  },
};

describe('access helpers', () => {
  test('empty allow lists permit access', () => {
    expect(isUserAllowed(config, 'ou_1')).toBe(true);
    expect(isChatAllowed(config, 'oc_1')).toBe(true);
    expect(isAdmin(config, 'ou_1')).toBe(true);
  });

  test('non-empty lists restrict access', () => {
    const restricted: any = {
      access: {
        allowedUsers: ['ou_admin'],
        allowedChats: ['oc_allowed'],
        admins: ['ou_admin'],
      },
    };

    expect(isUserAllowed(restricted, 'ou_admin')).toBe(true);
    expect(isUserAllowed(restricted, 'ou_other')).toBe(false);
    expect(isChatAllowed(restricted, 'oc_allowed')).toBe(true);
    expect(isChatAllowed(restricted, 'oc_other')).toBe(false);
    expect(isAdmin(restricted, 'ou_admin')).toBe(true);
    expect(isAdmin(restricted, 'ou_other')).toBe(false);
  });
});
