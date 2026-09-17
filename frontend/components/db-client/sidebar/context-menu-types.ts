import type { IconName } from '$shared/types/ui/icons';

export interface ContextMenuItem {
	id: string;
	label: string;
	icon?: IconName;
	danger?: boolean;
	separator?: boolean;
}
