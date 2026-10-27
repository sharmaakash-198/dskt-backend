export class AssignmentError extends Error {
  constructor(
    public readonly code:
      | 'unauthorized'
      | 'forbidden'
      | 'employee_not_found'
      | 'employee_inactive'
      | 'space_not_found'
      | 'space_not_assignable'
      | 'revision_not_published'
      | 'location_archived'
      | 'invalid_assignment_period'
      | 'space_already_assigned'
      | 'command_id_payload_mismatch',
    message?: string,
  ) {
    super(message || code);
    this.name = 'AssignmentError';
  }
}

export type CreateAssignmentInput = {
  employeeId: string;
  placementIdentityId: string;
  startedAt: string;
  endedAt?: string | null;
  clientCommandId?: string | null;
  actorUserId: string;
};

export type AssignmentView = {
  id: string;
  placementIdentityId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeEmail?: string | null;
  departmentName?: string | null;
  spaceLabel?: string | null;
  floorId: string;
  floorName: string;
  buildingName: string;
  siteName: string;
  startedAt: string;
  endedAt: string | null;
  assignedByUserId: string;
  clientCommandId?: string | null;
  createdAt: string;
};

export type QueryAssignmentsFilter = {
  employeeId?: string;
  placementIdentityId?: string;
  floorId?: string;
};
