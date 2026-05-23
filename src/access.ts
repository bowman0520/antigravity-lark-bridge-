import { ResolvedConfig } from './config';

export function isUserAllowed(config: ResolvedConfig, senderId: string): boolean {
  return config.access.allowedUsers.length === 0 || config.access.allowedUsers.includes(senderId);
}

export function isChatAllowed(config: ResolvedConfig, chatId: string): boolean {
  return config.access.allowedChats.length === 0 || config.access.allowedChats.includes(chatId);
}

export function isAdmin(config: ResolvedConfig, senderId: string): boolean {
  return config.access.admins.length === 0 || config.access.admins.includes(senderId);
}

export function formatList(values: string[]): string {
  return values.length === 0 ? '(any)' : values.join(', ');
}
