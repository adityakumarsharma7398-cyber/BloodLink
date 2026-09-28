import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Requests } from '@/pages/Requests/Requests';

const hoisted = vi.hoisted(() => ({
  useAuth: vi.fn(),
  createRoutineRequest: vi.fn(),
  listRoutineRequests: vi.fn(),
  createEmergencyRequest: vi.fn(),
  listEmergencyRequests: vi.fn(),
  getIncomingHolds: vi.fn(),
  selectSources: vi.fn(),
  decideSourceSelection: vi.fn(),
  getBloodGroups: vi.fn(),
  getComponents: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: hoisted.useAuth }));
vi.mock('@/services/routineRequests', () => ({
  createRoutineRequest: hoisted.createRoutineRequest,
  listRoutineRequests: hoisted.listRoutineRequests,
}));
vi.mock('@/services/emergency', () => ({
  createEmergencyRequest: hoisted.createEmergencyRequest,
  listEmergencyRequests: hoisted.listEmergencyRequests,
  getIncomingHolds: hoisted.getIncomingHolds,
  selectSources: hoisted.selectSources,
  decideSourceSelection: hoisted.decideSourceSelection,
}));
vi.mock('@/services/reference', () => ({
  getBloodGroups: hoisted.getBloodGroups,
  getComponents: hoisted.getComponents,
}));

const facility = { id: 'fac-1', name: 'ABC Hospital', organizationId: 'org-1', facilityType: 'HOSPITAL' };
const hospitalStaffMe = () => ({
  useAuth: {
    me: { user: { id: 'u1', email: 'a@b.invalid', fullName: 'Dr Sharma' }, organization: { id: 'org-1', name: 'ABC Hospital', type: 'HOSPITAL' }, primaryFacilityId: facility.id, roles: [{ role: 'HOSPITAL_STAFF', scope: 'FACILITY', organizationId: 'org-1', facilityId: facility.id }], facilities: [facility] },
    hasRole: (role: string) => role === 'HOSPITAL_STAFF',
    singleFacility: facility,
  },
});

const pageOf = (data: unknown[]) => ({ data, pagination: { page: 1, pageSize: 25, total: data.length } });

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.useAuth.mockReturnValue(hospitalStaffMe().useAuth);
  hoisted.getBloodGroups.mockResolvedValue({ data: [{ id: 1, code: 'O+', displayName: 'O Positive' }] });
  hoisted.getComponents.mockResolvedValue({ data: [{ id: 1, code: 'PRBC', name: 'Packed Red Blood Cells', active: true }] });
  hoisted.listRoutineRequests.mockResolvedValue(pageOf([]));
});

describe('the routine request form (HOSPITAL_STAFF / DOCTOR)', () => {
  it('asks for every field the backend needs, with an accessible label', async () => {
    render(<Requests />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeInTheDocument());
    expect(screen.getByLabelText('Blood group')).toBeInTheDocument();
    expect(screen.getByLabelText('Component')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Urgency')).toBeInTheDocument();
    expect(screen.getByLabelText('Required by')).toBeInTheDocument();
    // never asks for patient identity, contact details or free-text notes
    expect(screen.queryByLabelText(/patient|contact|notes/i)).not.toBeInTheDocument();
  });

  it('requires a quantity of at least 1 and a required-by time', async () => {
    render(<Requests />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeInTheDocument());
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('required');
    expect(screen.getByLabelText('Quantity')).toHaveAttribute('min', '1');
    expect(screen.getByLabelText('Required by')).toHaveAttribute('required');
  });

  it('shows the backend error message when submission fails', async () => {
    hoisted.createRoutineRequest.mockRejectedValue(new Error('The required-by time must be in the future'));
    render(<Requests />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Required by'), '2020-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText('The required-by time must be in the future')).toBeInTheDocument();
  });

  it('submits the form with the entered fields and refreshes the list on success', async () => {
    hoisted.createRoutineRequest.mockResolvedValue({ data: { id: 'req-1' } });
    render(<Requests />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeInTheDocument());
    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.type(screen.getByLabelText('Required by'), '2030-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => expect(hoisted.createRoutineRequest).toHaveBeenCalledWith(
      expect.objectContaining({ facilityId: facility.id, bloodGroupId: 1, componentId: 1, quantity: 3, urgency: 'NORMAL' }),
    ));
    // the list is refetched after a successful submission
    await waitFor(() => expect(hoisted.listRoutineRequests).toHaveBeenCalledTimes(2));
  });
});

describe('the routine request list', () => {
  it('shows a loading indicator while requests are being fetched', async () => {
    hoisted.listRoutineRequests.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Requests />);
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('renders each request, labelled as Routine, with its status and remaining quantity', async () => {
    hoisted.listRoutineRequests.mockResolvedValue(pageOf([
      {
        id: 'req-1', requestNumber: 'REQ-2026-000001', type: 'ROUTINE', urgency: 'NORMAL', requiredBy: new Date().toISOString(),
        status: 'OPEN', verification: { status: 'VERIFIED', method: 'STAFF_AT_CREATION', verifiedAt: new Date().toISOString() },
        facility: { id: facility.id, name: facility.name }, createdAt: new Date().toISOString(), sourceSelection: null,
        items: [{ id: 'item-1', bloodGroup: 'O+', component: 'PRBC', quantityRequested: 3, quantityFulfilled: 1, quantityRemaining: 2, allowCompatibleSubstitutes: true, holds: [] }],
      },
    ]));
    render(<Requests />);
    expect(await screen.findByText('REQ-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('Routine')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText(/O\+ PRBC — 2 of 3 remaining/)).toBeInTheDocument();
    // no "find sources" / source-selection action exists for a routine request
    expect(screen.queryByRole('button', { name: /find sources/i })).not.toBeInTheDocument();
  });

  it('shows a calm empty state when there are no requests yet', async () => {
    hoisted.listRoutineRequests.mockResolvedValue(pageOf([]));
    render(<Requests />);
    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('shows the backend error and a retry action if the list fails to load', async () => {
    hoisted.listRoutineRequests.mockRejectedValue(new Error('Backend is unreachable'));
    render(<Requests />);
    expect(await screen.findByText('Backend is unreachable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('role separation', () => {
  it('an EMERGENCY_STAFF-only identity sees the emergency section, not the routine create-request form', async () => {
    hoisted.useAuth.mockReturnValue({
      me: { user: { id: 'u2', email: 'e@b.invalid', fullName: 'Sunrise Staff' }, organization: null, primaryFacilityId: facility.id, roles: [{ role: 'EMERGENCY_STAFF', scope: 'FACILITY', organizationId: 'org-1', facilityId: facility.id }], facilities: [facility] },
      hasRole: (role: string) => role === 'EMERGENCY_STAFF',
      singleFacility: facility,
    });
    hoisted.listEmergencyRequests.mockResolvedValue(pageOf([]));
    render(<Requests />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit emergency request' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Submit request' })).not.toBeInTheDocument();
    expect(hoisted.listRoutineRequests).not.toHaveBeenCalled();
  });
});
