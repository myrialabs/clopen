<!--
  Date Separator Component
  
  Features:
  - WhatsApp-style date separator
  - Center-aligned with subtle styling
  - Shows dates in user-friendly format
  - Responsive design
-->

<script lang="ts">
	const { date }: { date: string } = $props();

	// Format date for display
	const formatDate = (dateString: string) => {
		const messageDate = new Date(dateString);
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);

		// Check if it's today
		if (messageDate.toDateString() === today.toDateString()) {
			return 'Today';
		}

		// Check if it's yesterday
		if (messageDate.toDateString() === yesterday.toDateString()) {
			return 'Yesterday';
		}

		// For older dates, show day and date
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const monthNames = [
			'January',
			'February',
			'March',
			'April',
			'May',
			'June',
			'July',
			'August',
			'September',
			'October',
			'November',
			'December'
		];

		const dayName = dayNames[messageDate.getDay()];
		const day = messageDate.getDate();
		const month = monthNames[messageDate.getMonth()];
		const year = messageDate.getFullYear();

		// Show year only if it's not current year
		if (year === today.getFullYear()) {
			return `${dayName}, ${day} ${month}`;
		} else {
			return `${dayName}, ${day} ${month} ${year}`;
		}
	};

	const displayDate = $derived(formatDate(date));
</script>

<!-- Date Separator -->
<div class="flex items-center justify-center my-3 md:my-4 px-4 md:px-6 select-none">
	<div class="relative flex items-center w-full max-w-md">
		<!-- Left line -->
		<div
			class="flex-grow h-px bg-gradient-to-r from-transparent via-violet-500/10 to-violet-500/20"
		></div>

		<!-- Date badge - WhatsApp style -->
		<div
			class="px-3 py-1 mx-2.5 bg-slate-100/80 dark:bg-slate-600/20 backdrop-blur-sm rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm"
		>
			<span class="text-xs font-medium text-slate-500 whitespace-nowrap tracking-wide">
				{displayDate}
			</span>
		</div>

		<!-- Right line -->
		<div
			class="flex-grow h-px bg-gradient-to-l from-transparent via-violet-500/10 to-violet-500/20"
		></div>
	</div>
</div>
