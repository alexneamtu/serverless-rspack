import { step } from './shared';

export const handler = async (event: { count?: number }): Promise<{ count: number }> => ({
  count: (event.count ?? 0) + step,
});
