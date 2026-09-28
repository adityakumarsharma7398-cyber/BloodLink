import { apiGet } from './api';

export interface BloodGroup {
  id: number;
  code: string;
  displayName: string;
  isKnown: boolean;
}
export interface Component {
  id: number;
  code: string;
  name: string;
  active: boolean;
}

export const getBloodGroups = () => apiGet<{ data: BloodGroup[] }>('/blood-groups');
export const getComponents = () => apiGet<{ data: Component[] }>('/components');
