<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		html: string;
		placeholder?: string;
		showDirectLinkImage?: boolean;
		showAttachmentButton?: boolean;
		showMarkdownIcon?: boolean;
		enableCodeToolbar?: boolean;
		dropdownAlign?: 'left' | 'right';
		mentionOptions?: { id: string; fullName: string; username: string; avatarUrl: string | null; isSpecial: boolean }[];
		onImageUpload?: (file: File) => Promise<string>;
	}

	let {
		html = $bindable(''),
		placeholder = '',
		showDirectLinkImage = false,
		showAttachmentButton = false,
		showMarkdownIcon = false,
		enableCodeToolbar = false,
		dropdownAlign = 'left',
		mentionOptions = [],
		onImageUpload = undefined
	}: Props = $props();

	let editorRef = $state<HTMLElement | null>(null);
	let autocompleteRef = $state<HTMLElement | null>(null);
	let codeToolbarRef = $state<HTMLElement | null>(null);
	let fileInputRef = $state<HTMLInputElement | null>(null);

	let showFormattingHelp = $state(false);
	let showMoreMenu = $state(false);
	let showListMenu = $state(false);
	let showInsertMenu = $state(false);

	function closeAllEditorMenus() {
		showMoreMenu = false;
		showListMenu = false;
		showInsertMenu = false;
	}

	let insertSearchQuery = $state('');
	let insertSelectedIndex = $state(0);
	let insertSubMenu = $state<'main' | 'mention' | 'emoji'>('main');
	let selectedEmojiCategory = $state('people');
	let hoveredEmoji = $state<{ char: string; name: string; code: string } | null>(null);

	const emojiCategories = [
		{ id: 'people', icon: 'lucide:smile', label: 'People' },
		{ id: 'nature', icon: 'lucide:trees', label: 'Nature' },
		{ id: 'food', icon: 'lucide:utensils', label: 'Food & Drink' },
		{ id: 'activity', icon: 'lucide:trophy', label: 'Activity' },
		{ id: 'travel', icon: 'lucide:car', label: 'Travel & Places' },
		{ id: 'objects', icon: 'lucide:lightbulb', label: 'Objects' },
		{ id: 'symbols', icon: 'lucide:heart', label: 'Symbols' },
		{ id: 'flags', icon: 'lucide:flag', label: 'Flags' }
	];

	const emojisData: Record<string, { char: string; name: string; code: string }[]> = {
		people: [
			{ char: '😀', name: 'Grinning Face', code: ':grinning:' },
			{ char: '😃', name: 'Grinning Face with Big Eyes', code: ':smiley:' },
			{ char: '😄', name: 'Grinning Face with Smiling Eyes', code: ':smile:' },
			{ char: '😁', name: 'Beaming Face with Smiling Eyes', code: ':grin:' },
			{ char: '😆', name: 'Grinning Squinting Face', code: ':laughing:' },
			{ char: '😅', name: 'Grinning Face with Sweat', code: ':sweat_smile:' },
			{ char: '😂', name: 'Face with Tears of Joy', code: ':joy:' },
			{ char: '🤣', name: 'Rolling on the Floor Laughing', code: ':rofl:' },
			{ char: '😇', name: 'Smiling Face with Halo', code: ':innocent:' },
			{ char: '😉', name: 'Winking Face', code: ':wink:' },
			{ char: '😊', name: 'Smiling Face with Smiling Eyes', code: ':blush:' },
			{ char: '😋', name: 'Face Savoring Food', code: ':yum:' },
			{ char: '😎', name: 'Smiling Face with Sunglasses', code: ':sunglasses:' },
			{ char: '😍', name: 'Smiling Face with Heart-Eyes', code: ':heart_eyes:' },
			{ char: '😘', name: 'Face Blowing a Kiss', code: ':kissing_heart:' },
			{ char: '😗', name: 'Kissing Face', code: ':kissing:' },
			{ char: '😙', name: 'Kissing Face with Smiling Eyes', code: ':kissing_smiling_eyes:' },
			{ char: '😚', name: 'Kissing Face with Closed Eyes', code: ':kissing_closed_eyes:' },
			{ char: '🙂', name: 'Slightly Smiling Face', code: ':slightly_smiling_face:' },
			{ char: '🤗', name: 'Hugging Face', code: ':hugs:' },
			{ char: '🤩', name: 'Star-Struck', code: ':star_struck:' },
			{ char: '🤔', name: 'Thinking Face', code: ':thinking:' },
			{ char: '🤨', name: 'Face with Raised Eyebrow', code: ':raised_eyebrow:' },
			{ char: '😐', name: 'Neutral Face', code: ':neutral_face:' },
			{ char: '😑', name: 'Expressionless Face', code: ':expressionless:' },
			{ char: '😶', name: 'Face Without Mouth', code: ':no_mouth:' },
			{ char: '🙄', name: 'Face with Rolling Eyes', code: ':roll_eyes:' },
			{ char: '😏', name: 'Smirking Face', code: ':smirk:' },
			{ char: '😣', name: 'Persevering Face', code: ':persevere:' },
			{ char: '😥', name: 'Sad but Relieved Face', code: ':disappointed_relieved:' },
			{ char: '😮', name: 'Face with Open Mouth', code: ':open_mouth:' },
			{ char: '🤐', name: 'Zipper-Mouth Face', code: ':zipper_mouth_face:' },
			{ char: '😯', name: 'Hushed Face', code: ':hushed:' },
			{ char: '😪', name: 'Sleepy Face', code: ':sleepy:' },
			{ char: '😫', name: 'Tired Face', code: ':tired_face:' },
			{ char: '😴', name: 'Sleeping Face', code: ':sleeping:' }
		],
		nature: [
			{ char: '🐶', name: 'Dog Face', code: ':dog:' },
			{ char: '🐱', name: 'Cat Face', code: ':cat:' },
			{ char: '🐭', name: 'Mouse Face', code: ':mouse:' },
			{ char: '🐹', name: 'Hamster Face', code: ':hamster:' },
			{ char: '🐰', name: 'Rabbit Face', code: ':rabbit:' },
			{ char: '🦊', name: 'Fox Face', code: ':fox:' },
			{ char: '🐻', name: 'Bear Face', code: ':bear:' },
			{ char: '🐼', name: 'Panda Face', code: ':panda_face:' },
			{ char: '🐨', name: 'Koala', code: ':koala:' },
			{ char: '🐯', name: 'Tiger Face', code: ':tiger:' },
			{ char: '🦁', name: 'Lion Face', code: ':lion:' },
			{ char: '🐮', name: 'Cow Face', code: ':cow:' },
			{ char: '🐷', name: 'Pig Face', code: ':pig:' },
			{ char: '🐸', name: 'Frog Face', code: ':frog:' },
			{ char: '🐵', name: 'Monkey Face', code: ':monkey_face:' },
			{ char: '🐔', name: 'Chicken', code: ':chicken:' },
			{ char: '🐧', name: 'Penguin', code: ':penguin:' },
			{ char: '🐦', name: 'Bird', code: ':bird:' },
			{ char: '🐤', name: 'Baby Chick', code: ':baby_chick:' },
			{ char: '🦆', name: 'Duck', code: ':duck:' },
			{ char: '🦅', name: 'Eagle', code: ':eagle:' },
			{ char: '🦉', name: 'Owl', code: ':owl:' },
			{ char: '🦇', name: 'Bat', code: ':bat:' },
			{ char: '🐺', name: 'Wolf Face', code: ':wolf:' },
			{ char: '🐗', name: 'Boar', code: ':boar:' },
			{ char: '🐴', name: 'Horse Face', code: ':horse:' },
			{ char: '🦄', name: 'Unicorn Face', code: ':unicorn:' },
			{ char: '🐝', name: 'Honeybee', code: ':bee:' },
			{ char: '🐛', name: 'Bug', code: ':bug:' },
			{ char: '🦋', name: 'Butterfly', code: ':butterfly:' },
			{ char: '🐌', name: 'Snail', code: ':snail:' },
			{ char: '🐞', name: 'Lady Beetle', code: ':lady_beetle:' },
			{ char: '🐜', name: 'Ant', code: ':ant:' },
			{ char: '🕷️', name: 'Spider', code: ':spider:' },
			{ char: '🐢', name: 'Turtle', code: ':turtle:' },
			{ char: '🐍', name: 'Snake', code: ':snake:' }
		],
		food: [
			{ char: '🍏', name: 'Green Apple', code: ':green_apple:' },
			{ char: '🍎', name: 'Red Apple', code: ':apple:' },
			{ char: '🍐', name: 'Pear', code: ':pear:' },
			{ char: '🍊', name: 'Tangerine', code: ':tangerine:' },
			{ char: '🍋', name: 'Lemon', code: ':lemon:' },
			{ char: '🍌', name: 'Banana', code: ':banana:' },
			{ char: '🍉', name: 'Watermelon', code: ':watermelon:' },
			{ char: '🍇', name: 'Grapes', code: ':grapes:' },
			{ char: '🍓', name: 'Strawberry', code: ':strawberry:' },
			{ char: '🍒', name: 'Cherries', code: ':cherries:' },
			{ char: '🍑', name: 'Peach', code: ':peach:' },
			{ char: '🍍', name: 'Pineapple', code: ':pineapple:' },
			{ char: '🥥', name: 'Coconut', code: ':coconut:' },
			{ char: '🥝', name: 'Kiwi Fruit', code: ':kiwi_fruit:' },
			{ char: '🍅', name: 'Tomato', code: ':tomato:' },
			{ char: '🥑', name: 'Avocado', code: ':avocado:' },
			{ char: '🍆', name: 'Eggplant', code: ':eggplant:' },
			{ char: '🥔', name: 'Potato', code: ':potato:' },
			{ char: '🥕', name: 'Carrot', code: ':carrot:' },
			{ char: '🌽', name: 'Ear of Maize', code: ':corn:' },
			{ char: '🌶️', name: 'Hot Pepper', code: ':hot_pepper:' },
			{ char: '🍄', name: 'Mushroom', code: ':mushroom:' },
			{ char: '🥜', name: 'Peanuts', code: ':peanuts:' },
			{ char: '🌰', name: 'Chestnut', code: ':chestnut:' },
			{ char: '🍞', name: 'Bread', code: ':bread:' },
			{ char: '🥐', name: 'Croissant', code: ':croissant:' },
			{ char: '🥖', name: 'Baguette Bread', code: ':baguette_bread:' },
			{ char: '🥨', name: 'Pretzel', code: ':pretzel:' },
			{ char: '🥞', name: 'Pancakes', code: ':pancakes:' },
			{ char: '🧀', name: 'Cheese Wedge', code: ':cheese:' },
			{ char: '🍖', name: 'Meat on Bone', code: ':meat_on_bone:' },
			{ char: '🍗', name: 'Poultry Leg', code: ':poultry_leg:' },
			{ char: '🥩', name: 'Cut of Meat', code: ':cut_of_meat:' },
			{ char: '🥓', name: 'Bacon', code: ':bacon:' },
			{ char: '🍔', name: 'Hamburger', code: ':hamburger:' },
			{ char: '🍟', name: 'French Fries', code: ':fries:' }
		],
		activity: [
			{ char: '⚽', name: 'Soccer Ball', code: ':soccer:' },
			{ char: '🏀', name: 'Basketball', code: ':basketball:' },
			{ char: '🏈', name: 'American Football', code: ':football:' },
			{ char: '⚾', name: 'Baseball', code: ':baseball:' },
			{ char: '🥎', name: 'Softball', code: ':softball:' },
			{ char: '🎾', name: 'Tennis', code: ':tennis:' },
			{ char: '🏐', name: 'Volleyball', code: ':volleyball:' },
			{ char: '🏉', name: 'Rugby Football', code: ':rugby_football:' },
			{ char: '🎱', name: 'Pool 8 Ball', code: ':8_ball:' },
			{ char: '🏓', name: 'Ping Pong', code: ':ping_pong:' },
			{ char: '🏸', name: 'Badminton', code: ':badminton:' },
			{ char: '🥅', name: 'Goal Net', code: ':goal_net:' },
			{ char: '⛳', name: 'Flag in Hole', code: ':golf:' },
			{ char: '⛸️', name: 'Ice Skate', code: ':ice_skate:' },
			{ char: '🎣', name: 'Fishing Pole', code: ':fishing_pole_and_fish:' },
			{ char: '🎽', name: 'Running Shirt with Sash', code: ':running_shirt_with_sash:' },
			{ char: '🎿', name: 'Skis', code: ':skis:' },
			{ char: '🛷', name: 'Sled', code: ':sled:' },
			{ char: '🥌', name: 'Curling Stone', code: ':curling_stone:' },
			{ char: '🎯', name: 'Direct Hit', code: ':dart:' },
			{ char: '🎮', name: 'Video Game', code: ':video_game:' },
			{ char: '🎰', name: 'Slot Machine', code: ':slot_machine:' },
			{ char: '🎲', name: 'Game Die', code: ':game_die:' },
			{ char: '🧩', name: 'Puzzle Piece', code: ':jigsaw:' },
			{ char: '🎳', name: 'Bowling', code: ':bowling:' }
		],
		travel: [
			{ char: '🚗', name: 'Automobile', code: ':car:' },
			{ char: '🚕', name: 'Taxi', code: ':taxi:' },
			{ char: '🚙', name: 'Recreational Vehicle', code: ':blue_car:' },
			{ char: '🚌', name: 'Bus', code: ':bus:' },
			{ char: '🚎', name: 'Trolleybus', code: ':trolleybus:' },
			{ char: '🏎️', name: 'Racing Car', code: ':racing_car:' },
			{ char: '🚓', name: 'Police Car', code: ':police_car:' },
			{ char: '🚑', name: 'Ambulance', code: ':ambulance:' },
			{ char: '🚒', name: 'Fire Engine', code: ':fire_engine:' },
			{ char: '🚐', name: 'Minibus', code: ':minibus:' },
			{ char: '🚚', name: 'Delivery Truck', code: ':truck:' },
			{ char: '🚛', name: 'Articulated Lorry', code: ':articulated_lorry:' },
			{ char: '🚜', name: 'Tractor', code: ':tractor:' },
			{ char: '🚲', name: 'Bicycle', code: ':bicycle:' },
			{ char: '🛵', name: 'Motor Scooter', code: ':motor_scooter:' },
			{ char: '🏍️', name: 'Motorcycle', code: ':motorcycle:' },
			{ char: '🚨', name: 'Police Car Light', code: ':rotating_light:' },
			{ char: '✈️', name: 'Airplane', code: ':airplane:' },
			{ char: '🛫', name: 'Airplane Departure', code: ':flight_departure:' },
			{ char: '🛬', name: 'Airplane Arrival', code: ':flight_arrival:' },
			{ char: '⛵', name: 'Sailboat', code: ':sailboat:' },
			{ char: '🛥️', name: 'Motor Boat', code: ':motorboat:' },
			{ char: '🛳️', name: 'Passenger Ship', code: ':passenger_ship:' },
			{ char: '🚢', name: 'Ship', code: ':ship:' }
		],
		objects: [
			{ char: '💡', name: 'Electric Light Bulb', code: ':lightbulb:' },
			{ char: '💻', name: 'Laptop Computer', code: ':computer:' },
			{ char: '📱', name: 'Mobile Phone', code: ':iphone:' },
			{ char: '☎️', name: 'Telephone', code: ':telephone:' },
			{ char: '📺', name: 'Television', code: ':tv:' },
			{ char: '📷', name: 'Camera', code: ':camera:' },
			{ char: '🔍', name: 'Magnifying Glass Left', code: ':search:' },
			{ char: '🕯️', name: 'Candle', code: ':candle:' },
			{ char: '🗑️', name: 'Wastebasket', code: ':wastebasket:' },
			{ char: '🔑', name: 'Key', code: ':key:' },
			{ char: '🔒', name: 'Locked', code: ':lock:' },
			{ char: '🔓', name: 'Unlocked', code: ':unlock:' },
			{ char: '🔨', name: 'Hammer', code: ':hammer:' },
			{ char: '🔧', name: 'Wrench', code: ':wrench:' },
			{ char: '📦', name: 'Package', code: ':package:' },
			{ char: '✉️', name: 'Envelope', code: ':envelope:' }
		],
		symbols: [
			{ char: '❤️', name: 'Red Heart', code: ':heart:' },
			{ char: '💛', name: 'Yellow Heart', code: ':yellow_heart:' },
			{ char: '💚', name: 'Green Heart', code: ':green_heart:' },
			{ char: '💙', name: 'Blue Heart', code: ':blue_heart:' },
			{ char: '💜', name: 'Purple Heart', code: ':purple_heart:' },
			{ char: '🖤', name: 'Black Heart', code: ':black_heart:' },
			{ char: '💔', name: 'Broken Heart', code: ':broken_heart:' },
			{ char: '❣️', name: 'Heart Exclamation', code: ':heavy_heart_exclamation:' },
			{ char: '💕', name: 'Two Hearts', code: ':two_hearts:' },
			{ char: '💞', name: 'Revolving Hearts', code: ':revolving_hearts:' },
			{ char: '💓', name: 'Beating Heart', code: ':heartbeat:' },
			{ char: '💗', name: 'Growing Heart', code: ':heartpulse:' },
			{ char: '💖', name: 'Sparkling Heart', code: ':sparkles:' },
			{ char: '💘', name: 'Heart with Arrow', code: ':cupid:' },
			{ char: '💝', name: 'Heart with Ribbon', code: ':gift_heart:' },
			{ char: '💟', name: 'Heart Decoration', code: ':heart_decoration:' },
			{ char: '🌟', name: 'Glowing Star', code: ':star2:' },
			{ char: '⭐', name: 'Star', code: ':star:' }
		],
		flags: [
			{ char: '🏁', name: 'Chequered Flag', code: ':checkered_flag:' },
			{ char: '🚩', name: 'Triangular Flag', code: ':triangular_flag_on_post:' },
			{ char: '🎌', name: 'Crossed Flags', code: ':crossed_flags:' },
			{ char: '🏴‍☠️', name: 'Pirate Flag', code: ':pirate_flag:' }
		]
	};

	const insertItems = [
		{
			id: 'mention',
			title: 'Mention',
			desc: 'Mention someone to send them a notification',
			icon: 'lucide:at-sign',
			shortcut: '@',
			action: () => {
				closeAllEditorMenus();
				if (editorRef) {
					editorRef.focus();
				}
				insertTextAtCursor('@');
				setTimeout(() => {
					checkAutocomplete();
				}, 0);
			}
		},
		{
			id: 'emoji',
			title: 'Emoji',
			desc: 'Use emojis to express ideas 🎉 and emotions 😄',
			icon: 'lucide:smile',
			shortcut: ':',
			action: () => {
				insertSubMenu = 'emoji';
				insertSearchQuery = '';
				insertSelectedIndex = 0;
				selectedEmojiCategory = 'people';
				hoveredEmoji = null;
			}
		},
		{
			id: 'link',
			title: 'Link',
			desc: 'Insert a hyperlink',
			icon: 'lucide:link',
			shortcut: '⌘K',
			action: () => {
				closeAllEditorMenus();
				insertLinkCommand();
			}
		},
		{
			id: 'image',
			title: 'Image',
			desc: 'Insert an image via URL',
			icon: 'lucide:image',
			shortcut: '⌘⇧I',
			action: () => {
				closeAllEditorMenus();
				insertImageCommand();
			}
		},
		{
			id: 'code',
			title: 'Code snippet',
			desc: 'Display code with syntax highlighting',
			icon: 'lucide:braces',
			shortcut: '```',
			action: () => {
				insertCodeBlock();
				closeAllEditorMenus();
			}
		},
		{
			id: 'quote',
			title: 'Quote',
			desc: 'Insert a block quote',
			icon: 'lucide:quote',
			shortcut: '>',
			action: () => {
				execEditorCommand('formatBlock', '<blockquote>');
				closeAllEditorMenus();
			}
		},
		{
			id: 'divider',
			title: 'Divider',
			desc: 'Insert a horizontal line divider',
			icon: 'lucide:minus',
			shortcut: '---',
			action: () => {
				execEditorCommand('insertHorizontalRule');
				closeAllEditorMenus();
			}
		}
	];

	const filteredInsertItems = $derived(
		insertItems
			.filter(item => !showDirectLinkImage || (item.id !== 'link' && item.id !== 'image'))
			.filter(item =>
				item.title.toLowerCase().includes(insertSearchQuery.toLowerCase()) ||
				item.desc.toLowerCase().includes(insertSearchQuery.toLowerCase())
			)
	);

	const filteredMentionOptions = $derived(
		mentionOptions.filter(m =>
			m.fullName.toLowerCase().includes(insertSearchQuery.toLowerCase()) ||
			m.username.toLowerCase().includes(insertSearchQuery.toLowerCase())
		)
	);

	const filteredEmojis = $derived.by(() => {
		if (!insertSearchQuery) {
			return emojisData[selectedEmojiCategory] || [];
		}
		const list: { char: string; name: string; code: string }[] = [];
		for (const cat in emojisData) {
			for (const emoji of emojisData[cat]) {
				if (
					emoji.name.toLowerCase().includes(insertSearchQuery.toLowerCase()) ||
					emoji.code.toLowerCase().includes(insertSearchQuery.toLowerCase())
				) {
					list.push(emoji);
				}
			}
		}
		return list;
	});

	const activeEmojiPreview = $derived.by(() => {
		if (hoveredEmoji) return hoveredEmoji;
		const list = filteredEmojis;
		if (list.length > 0 && insertSelectedIndex < list.length) {
			return list[insertSelectedIndex];
		}
		return null;
	});

	// Formatting active states
	let isBoldActive = $state(false);
	let isItalicActive = $state(false);
	let isHeadingActive = $state(false);
	let isBulletListActive = $state(false);
	let isNumberedListActive = $state(false);
	const isListActive = $derived(isBulletListActive || isNumberedListActive);
	let isStrikethroughActive = $state(false);
	let isCodeActive = $state(false);

	let activeCodeNode = $state<HTMLPreElement | null>(null);
	let activeCodeLanguage = $state('');
	let activeCodeIsWrapped = $state(false);
	let codeToolbarCoords = $state({ top: 0, left: 0 });

	const codeLanguages = [
		{ id: '', name: '(None)' },
		{ id: 'abap', name: 'ABAP' },
		{ id: 'actionscript', name: 'ActionScript' },
		{ id: 'ada', name: 'Ada' },
		{ id: 'applescript', name: 'AppleScript' },
		{ id: 'arduino', name: 'Arduino' },
		{ id: 'autoit', name: 'Autoit' },
		{ id: 'c', name: 'C' },
		{ id: 'cpp', name: 'C++' },
		{ id: 'csharp', name: 'C#' },
		{ id: 'css', name: 'CSS' },
		{ id: 'dart', name: 'Dart' },
		{ id: 'dockerfile', name: 'Dockerfile' },
		{ id: 'elixir', name: 'Elixir' },
		{ id: 'elm', name: 'Elm' },
		{ id: 'erlang', name: 'Erlang' },
		{ id: 'go', name: 'Go' },
		{ id: 'graphql', name: 'GraphQL' },
		{ id: 'groovy', name: 'Groovy' },
		{ id: 'haskell', name: 'Haskell' },
		{ id: 'html', name: 'HTML' },
		{ id: 'java', name: 'Java' },
		{ id: 'javascript', name: 'JavaScript' },
		{ id: 'json', name: 'JSON' },
		{ id: 'kotlin', name: 'Kotlin' },
		{ id: 'latex', name: 'LaTeX' },
		{ id: 'less', name: 'Less' },
		{ id: 'lisp', name: 'Lisp' },
		{ id: 'lua', name: 'Lua' },
		{ id: 'makefile', name: 'Makefile' },
		{ id: 'markdown', name: 'Markdown' },
		{ id: 'matlab', name: 'MATLAB' },
		{ id: 'objectivec', name: 'Objective-C' },
		{ id: 'pascal', name: 'Pascal' },
		{ id: 'perl', name: 'Perl' },
		{ id: 'php', name: 'PHP' },
		{ id: 'powershell', name: 'PowerShell' },
		{ id: 'python', name: 'Python' },
		{ id: 'r', name: 'R' },
		{ id: 'ruby', name: 'Ruby' },
		{ id: 'rust', name: 'Rust' },
		{ id: 'scala', name: 'Scala' },
		{ id: 'scheme', name: 'Scheme' },
		{ id: 'scss', name: 'SCSS' },
		{ id: 'shell', name: 'Shell' },
		{ id: 'sql', name: 'SQL' },
		{ id: 'swift', name: 'Swift' },
		{ id: 'toml', name: 'TOML' },
		{ id: 'typescript', name: 'TypeScript' },
		{ id: 'vbnet', name: 'VB.NET' },
		{ id: 'xml', name: 'XML' },
		{ id: 'yaml', name: 'YAML' }
	];

	function updateActiveFormats() {
		if (typeof document === 'undefined' || !editorRef) return;

		// Focus retention guard: if focus is currently inside the code block toolbar,
		// don't hide it or update formatting active states based on selection outside editor.
		const activeEl = document.activeElement;
		if (codeToolbarRef && activeEl && codeToolbarRef.contains(activeEl)) {
			return;
		}

		const selection = window.getSelection();
		const isSelectionInEditor = !!(selection && selection.rangeCount > 0 && selection.anchorNode && editorRef.contains(selection.anchorNode));

		isBoldActive = isSelectionInEditor ? document.queryCommandState('bold') : false;
		isItalicActive = isSelectionInEditor ? document.queryCommandState('italic') : false;
		isBulletListActive = isSelectionInEditor ? document.queryCommandState('insertUnorderedList') : false;
		isNumberedListActive = isSelectionInEditor ? document.queryCommandState('insertOrderedList') : false;
		isStrikethroughActive = isSelectionInEditor ? document.queryCommandState('strikeThrough') : false;
		
		// Check if cursor is in heading or code block
		if (isSelectionInEditor && selection) {
			const range = selection.getRangeAt(0);
			let parent: HTMLElement | null = range.commonAncestorContainer as HTMLElement;
			if (parent.nodeType === Node.TEXT_NODE) {
				parent = parent.parentElement;
			}
			
			// Heading check
			let heading = false;
			let headingParent: HTMLElement | null = parent;
			while (headingParent && headingParent !== editorRef) {
				if (headingParent.tagName === 'H3' || headingParent.tagName === 'H1' || headingParent.tagName === 'H2') {
					heading = true;
					break;
				}
				headingParent = headingParent.parentElement;
			}
			isHeadingActive = heading;

			// Code check
			let code = false;
			let codePre: HTMLPreElement | null = null;
			let codeParent: HTMLElement | null = parent;
			while (codeParent && codeParent !== editorRef) {
				if (codeParent.tagName === 'PRE') {
					code = true;
					codePre = codeParent as HTMLPreElement;
					break;
				}
				codeParent = codeParent.parentElement;
			}
			isCodeActive = code;
			activeCodeNode = codePre;

			if (codePre && enableCodeToolbar) {
				const codeEl = codePre.querySelector('code');
				const langClass = codeEl ? Array.from(codeEl.classList).find(c => c.startsWith('language-')) : null;
				activeCodeLanguage = langClass ? langClass.replace('language-', '') : '';
				activeCodeIsWrapped = codePre.classList.contains('whitespace-pre-wrap');
				
				const rect = codePre.getBoundingClientRect();
				const wrapperRect = editorRef.parentElement?.getBoundingClientRect();
				if (wrapperRect) {
					codeToolbarCoords = {
						top: rect.bottom - wrapperRect.top + 6,
						left: rect.left - wrapperRect.left + rect.width / 2
					};
				}
			} else {
				activeCodeLanguage = '';
				activeCodeIsWrapped = false;
			}
		} else {
			isHeadingActive = false;
			isCodeActive = false;
			activeCodeNode = null;
			activeCodeLanguage = '';
			activeCodeIsWrapped = false;
		}
	}

	$effect(() => {
		const handleSelectionChange = () => {
			updateActiveFormats();
		};
		document.addEventListener('selectionchange', handleSelectionChange);
		updateActiveFormats();
		return () => {
			document.removeEventListener('selectionchange', handleSelectionChange);
		};
	});

	function handleEditorSelectionOrInput() {
		updateActiveFormats();
		if (activeCodeNode && isCodeActive && enableCodeToolbar) {
			enforceCodeBlockStructure(activeCodeNode);
		}
		checkAutocomplete();
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		checkActiveLink();
	}

	function execEditorCommand(command: string, value: string = '') {
		document.execCommand(command, false, value);
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		updateActiveFormats();
	}

	function insertLinkCommand() {
		insertLinkUrl = '';
		insertLinkText = '';
		if (typeof window !== 'undefined') {
			const selection = window.getSelection();
			if (selection && selection.rangeCount > 0) {
				const range = selection.getRangeAt(0);
				if (editorRef && editorRef.contains(range.commonAncestorContainer)) {
					savedRange = range.cloneRange();
					insertLinkText = selection.toString();
				} else {
					savedRange = null;
				}
			} else {
				savedRange = null;
			}
		}
		showInsertLinkPopover = true;
	}

	function insertImageCommand() {
		insertImageUrl = '';
		if (typeof window !== 'undefined') {
			const selection = window.getSelection();
			if (selection && selection.rangeCount > 0) {
				const range = selection.getRangeAt(0);
				if (editorRef && editorRef.contains(range.commonAncestorContainer)) {
					savedRange = range.cloneRange();
				} else {
					savedRange = null;
				}
			} else {
				savedRange = null;
			}
		}
		showInsertImagePopover = true;
	}

	function handleInsertImageUrl() {
		if (typeof document === 'undefined' || !editorRef || !insertImageUrl.trim()) return;

		const url = insertImageUrl.trim();
		editorRef.focus();

		const selection = window.getSelection();
		if (selection) {
			selection.removeAllRanges();
			if (savedRange) {
				selection.addRange(savedRange);
			}

			const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
			if (range) {
				range.deleteContents();

				const imgNode = document.createElement('img');
				imgNode.setAttribute('src', url);
				imgNode.setAttribute('alt', 'image');
				imgNode.className = 'max-w-full h-auto rounded-lg my-2 inline-block';

				range.insertNode(imgNode);

				range.setStartAfter(imgNode);
				range.setEndAfter(imgNode);
				selection.removeAllRanges();
				selection.addRange(range);
			} else {
				const imgNode = document.createElement('img');
				imgNode.setAttribute('src', url);
				imgNode.setAttribute('alt', 'image');
				imgNode.className = 'max-w-full h-auto rounded-lg my-2 inline-block';
				editorRef.appendChild(imgNode);
			}
		}

		html = editorRef.innerHTML;
		showInsertImagePopover = false;
		savedRange = null;
		updateActiveFormats();
	}

	async function handleUploadImageFile(file: File) {
		isUploadingImage = true;
		try {
			if (onImageUpload) {
				const url = await onImageUpload(file);
				if (url) {
					insertImageUrl = url;
					handleInsertImageUrl();
				}
			} else {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					if (dataUrl) {
						insertImageUrl = dataUrl;
						handleInsertImageUrl();
					}
				};
				reader.readAsDataURL(file);
			}
		} catch (e) {
			debug.error('task-client', 'Image upload failed:', e);
		} finally {
			isUploadingImage = false;
		}
	}

	async function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (file) {
					if (typeof window !== 'undefined') {
						const selection = window.getSelection();
						if (selection && selection.rangeCount > 0) {
							savedRange = selection.getRangeAt(0).cloneRange();
						}
					}
					await handleUploadImageFile(file);
				}
				break;
			}
		}
	}

	async function handleDrop(e: DragEvent) {
		const files = e.dataTransfer?.files;
		if (!files) return;
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (file.type.startsWith('image/')) {
				e.preventDefault();
				if (typeof window !== 'undefined' && (document as any).caretRangeFromPoint) {
					const range = (document as any).caretRangeFromPoint(e.clientX, e.clientY);
					if (range) {
						savedRange = range;
					}
				}
				await handleUploadImageFile(file);
				break;
			}
		}
	}

	function insertTextAtCursor(text: string) {
		if (typeof document === 'undefined') return;
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		range.deleteContents();
		const textNode = document.createTextNode(text);
		range.insertNode(textNode);
		
		// Move cursor inside the text node to keep focus active on text level
		range.setStart(textNode, text.length);
		range.setEnd(textNode, text.length);
		selection.removeAllRanges();
		selection.addRange(range);
		
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		updateActiveFormats();
	}

	function insertCodeBlock() {
		if (typeof document === 'undefined') return;
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		
		const preNode = document.createElement('pre');
		preNode.className = 'bg-slate-900 text-slate-200 p-3 rounded-lg font-mono text-xs my-2 overflow-x-auto border border-slate-800';
		const codeNode = document.createElement('code');
		
		const text = range.toString().trim() || '// Write your code here';
		const lines = text.split(/\r?\n/);
		codeNode.innerHTML = lines.map(line => `<div>${line || '<br>'}</div>`).join('');
		preNode.appendChild(codeNode);
		
		range.deleteContents();
		range.insertNode(preNode);
		
		// Set focus inside the code block
		const newRange = document.createRange();
		newRange.selectNodeContents(codeNode);
		selection.removeAllRanges();
		selection.addRange(newRange);
		
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		updateActiveFormats();
	}

	function wrapSelectionInCode() {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		
		// If selection is empty, insert a placeholder code tag
		if (range.collapsed) {
			const codeNode = document.createElement('code');
			codeNode.className = 'bg-slate-900 text-slate-200 px-1 py-0.5 rounded font-mono text-xs';
			codeNode.innerHTML = 'code';
			range.insertNode(codeNode);
			
			// Move selection inside the code node
			const newRange = document.createRange();
			newRange.selectNodeContents(codeNode);
			selection.removeAllRanges();
			selection.addRange(newRange);
		} else {
			// Wrap selection in <code>
			const codeNode = document.createElement('code');
			codeNode.className = 'bg-slate-900 text-slate-200 px-1 py-0.5 rounded font-mono text-xs';
			codeNode.appendChild(range.extractContents());
			range.insertNode(codeNode);
			
			// Reselect the wrapped contents
			const newRange = document.createRange();
			newRange.selectNode(codeNode);
			selection.removeAllRanges();
			selection.addRange(newRange);
		}
		
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		updateActiveFormats();
	}

	function enforceCodeBlockStructure(preEl: HTMLPreElement) {
		const codeEl = preEl.querySelector('code');
		if (!codeEl) return;
		
		let hasTextOutsideDiv = false;
		for (const node of Array.from(codeEl.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '') {
				hasTextOutsideDiv = true;
				break;
			}
		}
		
		if (hasTextOutsideDiv) {
			const selection = window.getSelection();
			let caretOffset = 0;
			let activeDivIdx = 0;
			
			if (selection && selection.rangeCount > 0) {
				const range = selection.getRangeAt(0);
				const tempRange = range.cloneRange();
				tempRange.selectNodeContents(codeEl);
				tempRange.setEnd(range.startContainer, range.startOffset);
				
				const preCaretText = tempRange.toString();
				const caretLines = preCaretText.split('\n');
				activeDivIdx = caretLines.length - 1;
				caretOffset = caretLines[caretLines.length - 1].length;
			}
			
			const rawText = codeEl.textContent || '';
			const lines = rawText.split('\n');
			if (lines.length > 1 && lines[lines.length - 1] === '') {
				lines.pop();
			}
			
			const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
			const lang = langClass ? langClass.replace('language-', '') : '';
			
			codeEl.innerHTML = lines.map(line => `<div>${highlightCode(line, lang)}</div>`).join('');
			
			const divs = codeEl.querySelectorAll('div');
			if (divs.length > 0) {
				const targetDiv = divs[Math.min(activeDivIdx, divs.length - 1)];
				const newRange = document.createRange();
				
				let currentOffset = 0;
				let foundNode: Node | null = null;
				let nodeOffset = 0;
				
				function traverse(n: Node) {
					if (n.nodeType === Node.TEXT_NODE) {
						const len = n.textContent?.length || 0;
						if (currentOffset + len >= caretOffset) {
							foundNode = n;
							nodeOffset = caretOffset - currentOffset;
							return true;
						}
						currentOffset += len;
					} else {
						for (const child of Array.from(n.childNodes)) {
							if (traverse(child)) return true;
						}
					}
					return false;
				}
				
				traverse(targetDiv);
				
				if (foundNode) {
					try {
						newRange.setStart(foundNode, nodeOffset);
						newRange.setEnd(foundNode, nodeOffset);
						if (selection) {
							selection.removeAllRanges();
							selection.addRange(newRange);
						}
					} catch (err) {
						debug.error('task-client', 'Error restoring code block caret offset:', err);
					}
				}
			}
		}
	}

	function handleDeleteCodeBlock() {
		if (!activeCodeNode) return;
		activeCodeNode.remove();
		if (editorRef) {
			html = editorRef.innerHTML;
		}
		activeCodeNode = null;
		updateActiveFormats();
	}

	function handleSelectCodeLanguage(lang: string) {
		if (!activeCodeNode) return;
		const codeEl = activeCodeNode.querySelector('code');
		if (codeEl) {
			const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
			if (langClass) {
				codeEl.classList.remove(langClass);
			}
			if (lang) {
				codeEl.classList.add(`language-${lang}`);
			}
			
			const divs = codeEl.querySelectorAll('div');
			for (const div of Array.from(divs)) {
				const rawLineText = div.textContent || '';
				div.innerHTML = highlightCode(rawLineText, lang);
			}
		}
		
		activeCodeLanguage = lang;
		if (editorRef) {
			html = editorRef.innerHTML;
		}
	}

	function handleToggleCodeWrap() {
		if (!activeCodeNode) return;
		activeCodeNode.classList.toggle('whitespace-pre-wrap');
		activeCodeIsWrapped = activeCodeNode.classList.contains('whitespace-pre-wrap');
		if (editorRef) {
			html = editorRef.innerHTML;
		}
	}

	function highlightCode(line: string, lang: string): string {
		if (!line) return '<br>';
		const l = lang ? lang.toLowerCase() : '';
		
		const patterns: { class: string; regex: RegExp }[] = [
			{ class: 'token-comment', regex: /^\s*(\/\/.*|\/\*.*\*\/|#.*)/ },
			{ class: 'token-string', regex: /^("[^"]*"|'[^']*')/ },
			{ class: 'token-number', regex: /^(\b\d+(\.\d+)?\b)/ },
			{ class: 'token-keyword', regex: /^(\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|class|extends|new|this|typeof|instanceof|void|delete|try|catch|finally|throw|debugger|interface|type|public|private|protected|readonly|static|async|await|yield|package|implements|as|any|number|string|boolean|object|symbol|never|unknown|undefined|null|true|false)\b)/ },
			{ class: 'token-builtin', regex: /^(\b(console|window|document|process|require|module|exports|Object|Array|String|Number|Boolean|Function|Symbol|Error|RegExp|Map|Set|WeakMap|WeakSet|Promise|JSON|Math|Date)\b)/ },
			{ class: 'token-operator', regex: /^([+\-*/%&|^~=!<>]+)/ },
			{ class: 'token-function', regex: /^(\b\w+(?=\s*\())/ }
		];
		
		let result = '';
		let remaining = line;
		
		while (remaining.length > 0) {
			let matched = false;
			for (const pattern of patterns) {
				const match = pattern.regex.exec(remaining);
				if (match) {
					result += `<span class="${pattern.class}">${escapeHtml(match[0])}</span>`;
					remaining = remaining.slice(match[0].length);
					matched = true;
					break;
				}
			}
			
			if (!matched) {
				result += escapeHtml(remaining.charAt(0));
				remaining = remaining.slice(1);
			}
		}
		
		return result;
	}

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	// Autocomplete Mentions
	let showAutocomplete = $state(false);
	let autocompleteQuery = $state('');
	let autocompleteCoords = $state({ top: 0, left: 0 });
	let autocompleteSelectedIndex = $state(0);

	// Link Tooltip state
	let activeLinkNode = $state<HTMLAnchorElement | null>(null);
	let linkTooltipCoords = $state({ top: 0, left: 0 });
	let isEditingLink = $state(false);
	let linkEditUrl = $state('');
	let linkEditText = $state('');
	let copySuccess = $state(false);

	// Insert Link Popover state
	let showInsertLinkPopover = $state(false);
	let insertLinkUrl = $state('');
	let insertLinkText = $state('');
	let savedRange = $state<Range | null>(null);

	// Insert Image Popover state
	let showInsertImagePopover = $state(false);
	let insertImageUrl = $state('');
	let isUploadingImage = $state(false);

	function handleInsertLink() {
		if (typeof document === 'undefined' || !editorRef || !insertLinkUrl.trim()) return;
		
		const url = insertLinkUrl.trim();
		const text = insertLinkText.trim() || url;
		
		editorRef.focus();
		
		const selection = window.getSelection();
		if (selection) {
			selection.removeAllRanges();
			if (savedRange) {
				selection.addRange(savedRange);
			}
			
			const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
			if (range) {
				range.deleteContents();
				
				const anchorNode = document.createElement('a');
				anchorNode.setAttribute('href', url);
				anchorNode.textContent = text;
				
				range.insertNode(anchorNode);
				
				range.setStartAfter(anchorNode);
				range.setEndAfter(anchorNode);
				selection.removeAllRanges();
				selection.addRange(range);
			} else {
				const anchorNode = document.createElement('a');
				anchorNode.setAttribute('href', url);
				anchorNode.textContent = text;
				editorRef.appendChild(anchorNode);
			}
		}
		
		html = editorRef.innerHTML;
		showInsertLinkPopover = false;
		savedRange = null;
		updateActiveFormats();
	}

	function handleSaveEditLink() {
		if (activeLinkNode && linkEditUrl.trim()) {
			activeLinkNode.setAttribute('href', linkEditUrl.trim());
			activeLinkNode.textContent = linkEditText.trim() || linkEditUrl.trim();
			if (editorRef) html = editorRef.innerHTML;
			isEditingLink = false;
			activeLinkNode = null;
		}
	}

	function checkActiveLink() {
		if (typeof window === 'undefined' || !editorRef) return;

		// Skip auto-closing if currently focusing form fields inside editing tooltip
		if (isEditingLink && document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'BUTTON')) {
			return;
		}

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) {
			activeLinkNode = null;
			isEditingLink = false;
			return;
		}

		let node: Node | null = selection.anchorNode;
		while (node && node !== editorRef) {
			if (node.nodeName === 'A') {
				activeLinkNode = node as HTMLAnchorElement;
				if (!isEditingLink) {
					linkEditUrl = activeLinkNode.getAttribute('href') || '';
					linkEditText = activeLinkNode.textContent || '';
				}
				updateLinkTooltipPosition();
				return;
			}
			node = node.parentNode;
		}

		activeLinkNode = null;
		isEditingLink = false;
	}

	function updateLinkTooltipPosition() {
		if (!activeLinkNode || !editorRef) return;
		const rect = activeLinkNode.getBoundingClientRect();
		const parentRect = editorRef.parentElement?.getBoundingClientRect();
		if (parentRect) {
			linkTooltipCoords = {
				top: rect.bottom - parentRect.top + 8,
				left: rect.left - parentRect.left + (rect.width / 2)
			};
		}
	}

	$effect(() => {
		if (autocompleteQuery || showAutocomplete) {
			autocompleteSelectedIndex = 0;
		}
	});

	$effect(() => {
		if (showAutocomplete) {
			const handleGlobalClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (
					autocompleteRef && !autocompleteRef.contains(target) &&
					editorRef && !editorRef.contains(target)
				) {
					showAutocomplete = false;
				}
			};
			document.addEventListener('mousedown', handleGlobalClick);
			return () => {
				document.removeEventListener('mousedown', handleGlobalClick);
			};
		}
	});

	function checkAutocomplete() {
		if (typeof document === 'undefined' || !editorRef) return;
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
			showAutocomplete = false;
			return;
		}

		let anchorNode = selection.anchorNode;
		if (!anchorNode || !editorRef.contains(anchorNode)) {
			showAutocomplete = false;
			return;
		}

		const text = anchorNode.textContent || '';
		const caretOffset = selection.anchorOffset;
		const lastAtSymbolIndex = text.lastIndexOf('@', caretOffset - 1);
		if (lastAtSymbolIndex === -1) {
			showAutocomplete = false;
			return;
		}

		const query = text.slice(lastAtSymbolIndex + 1, caretOffset);
		const hasSpace = /\s/.test(query);
		if (hasSpace) {
			showAutocomplete = false;
			return;
		}

		showAutocomplete = true;
		autocompleteQuery = query;

		// Calculate selection coordinates
		try {
			const range = selection.getRangeAt(0);
			const clone = range.cloneRange();
			clone.setStart(anchorNode, lastAtSymbolIndex);
			clone.setEnd(anchorNode, caretOffset);
			
			const rects = clone.getClientRects();
			const parentRect = editorRef.parentElement?.getBoundingClientRect();
			if (rects.length > 0 && parentRect) {
				const rect = rects[0];
				autocompleteCoords = {
					top: rect.bottom - parentRect.top + 5,
					left: rect.left - parentRect.left
				};
			}
		} catch (err) {
			debug.error('task-client', 'Error calculating autocomplete coordinates:', err);
		}
	}

	function selectAutocompleteOption(member: { id: string; fullName: string; username: string }) {
		if (typeof document === 'undefined' || !editorRef) return;
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);

		let anchorNode = selection.anchorNode;
		if (!anchorNode) return;
		
		const text = anchorNode.textContent || '';
		const caretOffset = selection.anchorOffset;
		const lastAtSymbolIndex = text.lastIndexOf('@', caretOffset - 1);
		if (lastAtSymbolIndex === -1) return;

		// Create mention element
		const span = document.createElement('span');
		span.contentEditable = 'false';
		span.setAttribute('data-mention-id', member.id);
		span.setAttribute('data-username', member.username);
		
		if (member.id === 'card') {
			span.className = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-violet-600/20 text-violet-400 border border-violet-500/30';
		} else if (member.id === 'board') {
			span.className = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-sky-600/20 text-sky-400 border border-sky-500/30';
		} else {
			span.className = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-600/20 text-blue-400 border border-blue-500/30';
		}
		span.innerHTML = `@${member.username}`;

		range.setStart(anchorNode, lastAtSymbolIndex);
		range.setEnd(anchorNode, caretOffset);
		range.deleteContents();
		range.insertNode(span);

		const spaceNode = document.createTextNode('\u00A0');
		span.after(spaceNode);
		
		const newRange = document.createRange();
		newRange.setStart(spaceNode, 1);
		newRange.setEnd(spaceNode, 1);
		selection.removeAllRanges();
		selection.addRange(newRange);

		html = editorRef.innerHTML;
		showAutocomplete = false;
		updateActiveFormats();
	}

	const filteredAutocompleteOptions = $derived(
		mentionOptions.filter(m =>
			m.fullName.toLowerCase().includes(autocompleteQuery.toLowerCase()) ||
			m.username.toLowerCase().includes(autocompleteQuery.toLowerCase())
		)
	);

	function handleEditorKeydown(e: KeyboardEvent) {
		if (showAutocomplete) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				autocompleteSelectedIndex = (autocompleteSelectedIndex + 1) % filteredAutocompleteOptions.length;
				return;
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				autocompleteSelectedIndex = (autocompleteSelectedIndex - 1 + filteredAutocompleteOptions.length) % filteredAutocompleteOptions.length;
				return;
			} else if (e.key === 'Enter') {
				e.preventDefault();
				const selected = filteredAutocompleteOptions[autocompleteSelectedIndex];
				if (selected) {
					selectAutocompleteOption(selected);
				}
				return;
			} else if (e.key === 'Escape') {
				e.preventDefault();
				showAutocomplete = false;
				return;
			}
		}

		if (showInsertMenu && insertSubMenu === 'main') {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				insertSelectedIndex = (insertSelectedIndex + 1) % filteredInsertItems.length;
				return;
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				insertSelectedIndex = (insertSelectedIndex - 1 + filteredInsertItems.length) % filteredInsertItems.length;
				return;
			} else if (e.key === 'Enter') {
				e.preventDefault();
				const active = filteredInsertItems[insertSelectedIndex];
				if (active) {
					active.action();
				}
				return;
			}
		}

		// Escaping code blocks using ArrowDown / ArrowUp
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (typeof window !== 'undefined') {
				const selection = window.getSelection();
				if (selection && selection.rangeCount > 0) {
					let node: Node | null = selection.anchorNode;
					let codeBlock: HTMLElement | null = null;
					let preBlock: HTMLElement | null = null;
					while (node && node !== editorRef) {
						if (node.nodeName === 'CODE') {
							codeBlock = node as HTMLElement;
						}
						if (node.nodeName === 'PRE') {
							preBlock = node as HTMLElement;
							break;
						}
						node = node.parentNode;
					}

					if (preBlock && codeBlock) {
						if (e.key === 'ArrowDown') {
							// Check if we are inside the last line of the code block
							let isAtLastLine = true;
							let n: Node | null = selection.anchorNode;
							while (n && n !== codeBlock) {
								if (n.nextSibling) {
									isAtLastLine = false;
									break;
								}
								n = n.parentNode;
							}

							if (isAtLastLine) {
								const parent = preBlock.parentNode;
								if (parent) {
									const next = preBlock.nextElementSibling;
									if (next) {
										const newRange = document.createRange();
										newRange.selectNodeContents(next);
										newRange.collapse(true);
										selection.removeAllRanges();
										selection.addRange(newRange);
									} else {
										const pNode = document.createElement('p');
										pNode.innerHTML = '<br>';
										parent.appendChild(pNode);
										
										const newRange = document.createRange();
										newRange.selectNodeContents(pNode);
										newRange.collapse(true);
										selection.removeAllRanges();
										selection.addRange(newRange);
									}
									e.preventDefault();
									if (editorRef) html = editorRef.innerHTML;
									updateActiveFormats();
								}
							}
						} else if (e.key === 'ArrowUp') {
							// Check if we are inside the first line of the code block
							let isAtFirstLine = true;
							let n: Node | null = selection.anchorNode;
							while (n && n !== codeBlock) {
								if (n.previousSibling) {
									isAtFirstLine = false;
									break;
								}
								n = n.parentNode;
							}

							if (isAtFirstLine) {
								const parent = preBlock.parentNode;
								if (parent) {
									const prev = preBlock.previousElementSibling;
									if (prev) {
										const newRange = document.createRange();
										newRange.selectNodeContents(prev);
										newRange.collapse(false); // collapse to end
										selection.removeAllRanges();
										selection.addRange(newRange);
									} else {
										const pNode = document.createElement('p');
										pNode.innerHTML = '<br>';
										parent.insertBefore(pNode, preBlock);
										
										const newRange = document.createRange();
										newRange.selectNodeContents(pNode);
										newRange.collapse(true);
										selection.removeAllRanges();
										selection.addRange(newRange);
									}
									e.preventDefault();
									if (editorRef) html = editorRef.innerHTML;
									updateActiveFormats();
								}
							}
						}
					}
				}
			}
		}

		const isMac = typeof navigator !== 'undefined' && navigator.platform.indexOf('Mac') > -1;
		const modifier = isMac ? e.metaKey : e.ctrlKey;

		if (modifier && e.shiftKey && e.key.toLowerCase() === 's') {
			e.preventDefault();
			execEditorCommand('strikeThrough');
		} else if (modifier && e.shiftKey && e.key.toLowerCase() === 'm') {
			e.preventDefault();
			wrapSelectionInCode();
		} else if (modifier && e.key === '\\') {
			e.preventDefault();
			execEditorCommand('removeFormat');
		}
	}

	$effect(() => {
		if (insertSearchQuery || showInsertMenu || insertSubMenu) {
			insertSelectedIndex = 0;
		}
	});

	$effect(() => {
		if (!showInsertMenu) {
			insertSearchQuery = '';
			insertSubMenu = 'main';
		}
	});
</script>

<div class="w-full rounded-xl border border-slate-800 bg-slate-950 relative z-20">
	<!-- Toolbar -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/30 rounded-t-xl select-none">
		<!-- Left Actions -->
		<div class="flex items-center gap-1">
			<!-- Text style -->
			<button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => execEditorCommand('formatBlock', '<h3>')} class="flex items-center gap-0.5 h-7 px-2 rounded-lg hover:bg-slate-800 text-xs font-semibold border-none cursor-pointer transition-colors {isHeadingActive ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}" title="Heading">
				<span class="font-serif">Tt</span>
				<Icon name="lucide:chevron-down" class="w-3 h-3" />
			</button>
			<div class="h-4 w-[1px] bg-slate-800 mx-1"></div>
			<!-- Bold -->
			<button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => execEditorCommand('bold')} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 cursor-pointer border-none transition-colors {isBoldActive ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}" title="Bold">
				<Icon name="lucide:bold" class="w-3.5 h-3.5" />
			</button>
			<!-- Italic -->
			<button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => execEditorCommand('italic')} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 cursor-pointer border-none transition-colors {isItalicActive ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}" title="Italic">
				<Icon name="lucide:italic" class="w-3.5 h-3.5" />
			</button>
			<!-- More -->
			<div class="relative flex items-center">
				<button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => { const wasOpen = showMoreMenu; closeAllEditorMenus(); showMoreMenu = !wasOpen; }} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 border-none cursor-pointer transition-colors {showMoreMenu || isStrikethroughActive || isCodeActive ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}" title="More formatting">
					<Icon name="lucide:ellipsis" class="w-3.5 h-3.5" />
				</button>
				{#if showMoreMenu}
					<!-- Click outside overlay -->
					<button
						type="button"
						class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full"
						onclick={() => showMoreMenu = false}
						aria-label="Close formatting menu"
					></button>
					
					<!-- Dropdown content -->
					<div class="absolute top-full left-0 mt-1 z-50 w-56 p-1.5 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl flex flex-col gap-0.5">
						<!-- Strikethrough -->
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => { execEditorCommand('strikeThrough'); showMoreMenu = false; }}
							class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-semibold border-none cursor-pointer text-left transition-colors animate-in fade-in zoom-in-95 duration-100 {isStrikethroughActive ? 'bg-slate-800 text-violet-400' : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800 bg-transparent'}"
						>
							<span>Strikethrough</span>
							<span class="text-[10px] text-slate-500 font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">⌘⇧S</span>
						</button>
						<!-- Code -->
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => { wrapSelectionInCode(); showMoreMenu = false; }}
							class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-semibold border-none cursor-pointer text-left transition-colors animate-in fade-in zoom-in-95 duration-100 {isCodeActive ? 'bg-slate-800 text-violet-400' : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800 bg-transparent'}"
						>
							<span>Code</span>
							<span class="text-[10px] text-slate-500 font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">⌘⇧M</span>
						</button>
						<!-- Divider -->
						<div class="h-[1px] bg-slate-800 my-1"></div>
						<!-- Clear Formatting -->
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => { execEditorCommand('removeFormat'); showMoreMenu = false; }}
							class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-800 bg-transparent border-none cursor-pointer text-left transition-colors animate-in fade-in zoom-in-95 duration-100"
						>
							<span>Clear formatting</span>
							<span class="text-[10px] text-slate-500 font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">⌘\</span>
						</button>
					</div>
				{/if}
			</div>
			<div class="h-4 w-[1px] bg-slate-800 mx-1"></div>
			<!-- Lists -->
			<div class="relative flex items-center">
				<button
					type="button"
					onmousedown={(e) => e.preventDefault()}
					onclick={() => { const wasOpen = showListMenu; closeAllEditorMenus(); showListMenu = !wasOpen; }}
					class="flex items-center gap-0.5 h-7 px-1.5 rounded-lg hover:bg-slate-800 border-none cursor-pointer transition-colors {showListMenu || isListActive ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}"
					title="Lists"
				>
					<Icon name="lucide:list" class="w-3.5 h-3.5" />
					<Icon name="lucide:chevron-down" class="w-3.5 h-3.5" />
				</button>
				{#if showListMenu}
					<!-- Click outside overlay -->
					<button
						type="button"
						class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full"
						onclick={() => showListMenu = false}
						aria-label="Close list menu"
					></button>
					
					<!-- Dropdown content -->
					<div class="absolute top-full left-0 mt-1 z-50 w-44 p-1.5 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl flex flex-col gap-0.5">
						<!-- Bullet List -->
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => { execEditorCommand('insertUnorderedList'); showListMenu = false; }}
							class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs font-semibold border-none cursor-pointer text-left transition-colors animate-in fade-in zoom-in-95 duration-100 {isBulletListActive ? 'bg-slate-800 text-violet-400' : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800 bg-transparent'}"
						>
							<Icon name="lucide:list" class="w-3.5 h-3.5 shrink-0" />
							<span>Bullet list</span>
						</button>
						<!-- Numbered List -->
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => { execEditorCommand('insertOrderedList'); showListMenu = false; }}
							class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs font-semibold border-none cursor-pointer text-left transition-colors animate-in fade-in zoom-in-95 duration-100 {isNumberedListActive ? 'bg-slate-800 text-violet-400' : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800 bg-transparent'}"
						>
							<Icon name="lucide:list-ordered" class="w-3.5 h-3.5 shrink-0" />
							<span>Numbered list</span>
						</button>
					</div>
				{/if}
			</div>
			<div class="h-4 w-[1px] bg-slate-800 mx-1"></div>
			{#if showDirectLinkImage}
				<button type="button" onmousedown={(e) => e.preventDefault()} onclick={insertLinkCommand} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer transition-colors" title="Link">
					<Icon name="lucide:link" class="w-3.5 h-3.5" />
				</button>
				<button type="button" onmousedown={(e) => e.preventDefault()} onclick={insertImageCommand} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer transition-colors" title="Image">
					<Icon name="lucide:image" class="w-3.5 h-3.5" />
				</button>
			{/if}

			<!-- Insert element -->
			<div class="relative flex items-center">
				<button
					type="button"
					onmousedown={(e) => e.preventDefault()}
					onclick={() => { const wasOpen = showInsertMenu; closeAllEditorMenus(); showInsertMenu = !wasOpen; }}
					class="flex items-center gap-0.5 h-7 px-1.5 rounded-lg hover:bg-slate-800 border-none cursor-pointer transition-colors {showInsertMenu ? 'bg-slate-800 text-violet-400' : 'text-slate-400 hover:text-slate-200 bg-transparent'}"
					title="Insert element"
				>
					<Icon name="lucide:plus" class="w-3.5 h-3.5" />
					<Icon name="lucide:chevron-down" class="w-3.5 h-3.5" />
				</button>
				{#if showInsertMenu}
					<!-- Click outside overlay -->
					<button
						type="button"
						class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full"
						onclick={() => showInsertMenu = false}
						aria-label="Close insert menu"
					></button>
					
					<!-- Dropdown content -->
					<div class="absolute top-full mt-1 z-50 w-72 p-2 rounded-xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col gap-1.5 animate-in fade-in zoom-in-95 duration-150 {dropdownAlign === 'right' ? 'right-0' : 'left-0'}">
						{#if insertSubMenu === 'main'}
							<!-- Search Input wrapper -->
							<div class="relative flex items-center px-2.5 py-1.5 bg-slate-900 rounded-lg border border-slate-800 focus-within:border-slate-700">
								<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
								<input
									type="text"
									bind:value={insertSearchQuery}
									onkeydown={handleEditorKeydown}
									placeholder="Search"
									autofocus
									class="w-full bg-transparent border-none text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-0 p-0"
								/>
								<span class="text-[9px] text-slate-500 font-mono bg-slate-950 px-1 py-0.5 rounded border border-slate-800 shrink-0 ml-2">↵ Enter</span>
							</div>
							
							<!-- Items list -->
							<div class="flex flex-col max-h-64 overflow-y-auto pr-0.5">
								{#if filteredInsertItems.length === 0}
									<div class="text-[11px] text-slate-500 text-center py-4 select-none">No options match query</div>
								{:else}
									{#each filteredInsertItems as item, idx}
										{@const isSelected = idx === insertSelectedIndex}
										<button
											type="button"
											onmousedown={(e) => e.preventDefault()}
											onclick={item.action}
											onmouseenter={() => insertSelectedIndex = idx}
											class="relative w-full flex items-center justify-between gap-3 p-2 rounded-lg border-none cursor-pointer text-left transition-colors {isSelected ? 'bg-slate-850/80 text-violet-400' : 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/40'}"
										>
											{#if isSelected}
												<div class="absolute left-0 top-1 bottom-1 w-[3px] bg-violet-500 rounded-r"></div>
											{/if}
											<div class="flex items-start gap-3 min-w-0 flex-grow">
												<Icon name={item.icon as any} class="w-4 h-4 shrink-0 text-slate-400 mt-0.5" />
												<div class="flex-grow min-w-0">
													<span class="text-xs font-semibold block">{item.title}</span>
													<span class="text-[10px] text-slate-500 block whitespace-normal pr-1">{item.desc}</span>
												</div>
											</div>
											{#if item.shortcut}
												<span class="text-[10px] text-slate-500 font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 shrink-0 self-center">{item.shortcut}</span>
											{/if}
										</button>
									{/each}
								{/if}
							</div>
						{:else if insertSubMenu === 'mention'}
							<!-- Mentions menu -->
							<div class="flex flex-col max-h-64 overflow-y-auto pr-0.5">
								{#each filteredMentionOptions as member, idx}
									{@const isSelected = idx === autocompleteSelectedIndex}
									<button
										type="button"
										onmousedown={(e) => e.preventDefault()}
										onclick={() => { insertTextAtCursor(`@${member.username} `); showInsertMenu = false; }}
										onmouseenter={() => autocompleteSelectedIndex = idx}
										class="relative w-full flex items-center gap-3 p-2 rounded-lg border-none cursor-pointer text-left transition-colors {isSelected ? 'bg-slate-800/80 text-violet-400' : 'bg-transparent text-slate-300 hover:text-slate-200 hover:bg-slate-900'}"
									>
										{#if isSelected}
											<div class="absolute left-0 top-1 bottom-1 w-[3px] bg-violet-500 rounded-r"></div>
										{/if}
										{#if member.avatarUrl}
											<img src="{member.avatarUrl}/30.png" alt={member.fullName} class="w-8 h-8 rounded-full object-cover shrink-0 border border-slate-800" />
										{/if}
										<div class="flex-grow min-w-0">
											<span class="text-xs font-semibold block truncate">{member.fullName}</span>
											<span class="text-[10px] text-slate-500 block truncate">@{member.username}</span>
										</div>
									</button>
								{/each}
							</div>
						{:else if insertSubMenu === 'emoji'}
							<!-- Emoji list picker -->
							<div class="flex flex-col gap-2">
								<div class="flex items-center gap-1 border-b border-slate-800 pb-1.5">
									{#each emojiCategories as cat}
										<button
											type="button"
											onmousedown={(e) => e.preventDefault()}
											onclick={() => { selectedEmojiCategory = cat.id; hoveredEmoji = null; }}
											class="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-850 border-none cursor-pointer transition-colors {selectedEmojiCategory === cat.id ? 'bg-slate-800 text-violet-400' : 'text-slate-500 hover:text-slate-300 bg-transparent'}"
											title={cat.label}
										>
											<Icon name={cat.icon as any} class="w-4 h-4" />
										</button>
									{/each}
								</div>
								<div class="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto pr-0.5">
									{#each emojisData[selectedEmojiCategory] as emoji}
										<button
											type="button"
											onmousedown={(e) => e.preventDefault()}
											onclick={() => { insertTextAtCursor(emoji.char); showInsertMenu = false; }}
											onmouseenter={() => hoveredEmoji = emoji}
											class="w-7 h-7 flex items-center justify-center text-base rounded hover:bg-slate-800 border-none cursor-pointer transition-colors bg-transparent"
											title={emoji.name}
										>
											{emoji.char}
										</button>
									{/each}
								</div>
								{#if hoveredEmoji}
									<div class="flex items-center gap-2 border-t border-slate-800 pt-1.5 px-1 select-none">
										<span class="text-xl shrink-0">{hoveredEmoji.char}</span>
										<div class="flex-grow min-w-0">
											<span class="text-[10px] font-semibold text-slate-300 block truncate leading-none mb-1">{hoveredEmoji.name}</span>
											<span class="text-[9px] font-mono text-slate-500 block truncate leading-none">{hoveredEmoji.code}</span>
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<!-- Right Actions -->
		<div class="flex items-center gap-2">
			{#if showAttachmentButton}
				<button type="button" onmousedown={(e) => e.preventDefault()} onclick={insertLinkCommand} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer transition-colors" title="Add attachment">
					<Icon name="lucide:paperclip" class="w-3.5 h-3.5" />
				</button>
			{/if}

			{#if showMarkdownIcon}
				<a href="https://www.markdownguide.org/cheat-sheet/" target="_blank" class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-500 hover:text-slate-400 transition-colors" title="Markdown is supported">
					<span class="text-xs font-bold font-mono">M↓</span>
				</a>
			{/if}

			<button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => showFormattingHelp = !showFormattingHelp} class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer transition-colors" title="Formatting help">
				<Icon name="lucide:circle-question-mark" class="w-3.5 h-3.5" />
			</button>
		</div>
	</div>

	<!-- ContentEditable Area -->
	<div
		bind:this={editorRef}
		contenteditable="true"
		bind:innerHTML={html}
		{placeholder}
		class="w-full min-h-[120px] p-3 bg-transparent border-none text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 focus:border-none resize-y leading-relaxed outline-none empty:before:content-[attr(placeholder)] empty:before:text-slate-500 empty:before:pointer-events-none font-sans selection:bg-violet-500/30 selection:text-white"
		autofocus
		onmouseup={handleEditorSelectionOrInput}
		onkeyup={handleEditorSelectionOrInput}
		onfocus={handleEditorSelectionOrInput}
		oninput={handleEditorSelectionOrInput}
		onkeydown={handleEditorKeydown}
		onpaste={handlePaste}
		ondrop={handleDrop}
	></div>

	{#if showAutocomplete && filteredAutocompleteOptions.length > 0}
		<div
			bind:this={autocompleteRef}
			id="desc-autocomplete-menu"
			style="top: {autocompleteCoords.top}px; left: {autocompleteCoords.left}px;"
			class="absolute z-50 w-72 p-2 rounded-xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col gap-1.5 animate-in fade-in zoom-in-95 duration-150"
		>
			<div class="flex flex-col max-h-64 overflow-y-auto pr-0.5">
				{#each filteredAutocompleteOptions as member, idx}
					{@const isSelected = idx === autocompleteSelectedIndex}
					<button
						type="button"
						onmousedown={(e) => e.preventDefault()}
						onclick={() => selectAutocompleteOption(member)}
						onmouseenter={() => autocompleteSelectedIndex = idx}
						class="relative w-full flex items-center gap-3 p-2 rounded-lg border-none cursor-pointer text-left transition-colors {isSelected ? 'bg-slate-800/80 text-violet-400' : 'bg-transparent text-slate-300 hover:text-slate-200 hover:bg-slate-900'}"
					>
						{#if isSelected}
							<div class="absolute left-0 top-1 bottom-1 w-[3px] bg-violet-500 rounded-r"></div>
						{/if}
						{#if member.avatarUrl}
							<img src="{member.avatarUrl}/30.png" alt={member.fullName} class="w-8 h-8 rounded-full object-cover shrink-0 border border-slate-800" />
						{/if}
						<div class="flex-grow min-w-0">
							<span class="text-xs font-semibold block truncate">{member.fullName}</span>
							<span class="text-[10px] text-slate-500 block truncate">@{member.username}</span>
						</div>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if showInsertLinkPopover}
		<button
			type="button"
			onclick={() => showInsertLinkPopover = false}
			class="fixed inset-0 z-[300] bg-slate-950/40 cursor-default border-none w-full h-full backdrop-blur-[1px]"
			aria-label="Close insert link popover"
		></button>
		<div
			class="fixed inset-0 z-[310] pointer-events-none flex items-center justify-center"
		>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					if (insertLinkUrl.trim()) {
						handleInsertLink();
					}
				}}
				onmousedown={(e) => e.stopPropagation()}
				class="pointer-events-auto w-80 p-4.5 rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col gap-4 text-slate-200 animate-in fade-in zoom-in-95 duration-150"
			>
				<div class="flex items-center justify-between">
					<span class="text-xs font-bold text-slate-200">Insert link</span>
					<button
						type="button"
						onclick={() => showInsertLinkPopover = false}
						class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-850 transition border-none bg-transparent cursor-pointer"
						aria-label="Close link popover"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-bold text-slate-200">Link <span class="text-red-400">*</span></label>
					<input
						type="text"
						placeholder="Paste a link"
						bind:value={insertLinkUrl}
						class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-600"
						autofocus
					/>
				</div>
				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-bold text-slate-200">Display text (optional)</label>
					<input
						type="text"
						placeholder="Text to display"
						bind:value={insertLinkText}
						class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-600"
					/>
					<span class="text-[10px] text-slate-500">Give this link a title or description</span>
				</div>
				<div class="flex justify-end mt-1">
					<button
						type="submit"
						disabled={!insertLinkUrl.trim()}
						class="px-5 py-2 text-sm bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-semibold transition cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Insert
					</button>
				</div>
			</form>
		</div>
	{/if}

	{#if showInsertImagePopover}
		<button
			type="button"
			onclick={() => showInsertImagePopover = false}
			class="fixed inset-0 z-[300] bg-slate-950/40 cursor-default border-none w-full h-full backdrop-blur-[1px]"
			aria-label="Close insert image popover"
		></button>
		<div
			class="fixed inset-0 z-[310] pointer-events-none flex items-center justify-center"
		>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					if (insertImageUrl.trim()) {
						handleInsertImageUrl();
					}
				}}
				onmousedown={(e) => e.stopPropagation()}
				class="pointer-events-auto w-80 p-4.5 rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl flex flex-col gap-4 text-slate-200 animate-in fade-in zoom-in-95 duration-150"
			>
				<div class="flex items-center justify-between">
					<span class="text-xs font-bold text-slate-200">Select image</span>
					<button
						type="button"
						onclick={() => showInsertImagePopover = false}
						class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-850 transition border-none bg-transparent cursor-pointer"
						aria-label="Close image popover"
					>
						<Icon name="lucide:x" class="w-3.5 h-3.5" />
					</button>
				</div>

				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-bold text-slate-200">Attach an image link</label>
					<div class="flex gap-2">
						<input
							type="text"
							placeholder="https://example.com"
							bind:value={insertImageUrl}
							class="flex-grow px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-600"
							autofocus
						/>
						<button
							type="submit"
							disabled={!insertImageUrl.trim()}
							class="px-4 py-1.5 text-xs bg-slate-850 hover:bg-slate-800 text-slate-200 rounded-lg font-semibold transition cursor-pointer border border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Submit
						</button>
					</div>
				</div>

				<div class="flex flex-col gap-1.5 mt-1.5">
					<input
						type="file"
						accept="image/*"
						class="hidden"
						bind:this={fileInputRef}
						onchange={(e) => {
							const file = e.currentTarget.files?.[0];
							if (file) handleUploadImageFile(file);
						}}
					/>
					<button
						type="button"
						disabled={isUploadingImage}
						onclick={() => fileInputRef?.click()}
						class="w-full py-2 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-850 text-slate-350 hover:text-slate-200 text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{#if isUploadingImage}
							<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
							<span>Uploading...</span>
						{:else}
							<Icon name="lucide:upload" class="w-3.5 h-3.5" />
							<span>Upload from your computer</span>
						{/if}
					</button>
				</div>
			</form>
		</div>
	{/if}

	{#if activeLinkNode}
		<div
			onmousedown={(e) => { if (!isEditingLink) e.preventDefault(); }}
			style="top: {linkTooltipCoords.top}px; left: {linkTooltipCoords.left}px; transform: translateX(-50%);"
			class="absolute z-[60] p-1 rounded-lg border border-slate-800 bg-slate-950 shadow-2xl flex flex-col gap-1 text-xs select-none"
		>
			{#if isEditingLink}
				<!-- Link Edit Form -->
				<form
					onsubmit={(e) => {
						e.preventDefault();
						handleSaveEditLink();
					}}
					class="flex flex-col gap-2 p-3.5 w-64 text-slate-200 animate-in fade-in zoom-in-95 duration-150"
				>
					<div class="flex flex-col gap-1.5">
						<label class="text-[10px] font-bold text-slate-400 uppercase">Link <span class="text-red-400">*</span></label>
						<input
							type="text"
							bind:value={linkEditUrl}
							class="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500"
						/>
					</div>
					<div class="flex flex-col gap-1.5">
						<label class="text-[10px] font-bold text-slate-400 uppercase">Display text (optional)</label>
						<input
							type="text"
							bind:value={linkEditText}
							class="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500"
						/>
					</div>
					<div class="flex gap-2 justify-end mt-1.5">
						<button
							type="button"
							onclick={() => isEditingLink = false}
							class="px-3 py-1.5 text-xs bg-transparent hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg font-semibold transition cursor-pointer border border-slate-850"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!linkEditUrl.trim()}
							class="px-3.5 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-semibold transition cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Save
						</button>
					</div>
				</form>
			{:else}
				<!-- Link Action Bar -->
				<div class="flex items-center gap-0.5 animate-in fade-in zoom-in-95 duration-100">
					<button
						type="button"
						onclick={() => isEditingLink = true}
						class="px-2.5 py-1 hover:bg-slate-800 rounded-lg font-semibold text-slate-300 hover:text-slate-100 transition cursor-pointer border-none bg-transparent text-xs"
					>
						Edit link
					</button>
					
					<div class="h-4 w-[1px] bg-slate-800 mx-1"></div>

					<a
						href={linkEditUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
						title="Open link in new tab"
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
					</a>

					<button
						type="button"
						onclick={() => {
							if (activeLinkNode) {
								const text = activeLinkNode.textContent || '';
								const textNode = document.createTextNode(text);
								activeLinkNode.replaceWith(textNode);
								if (editorRef) html = editorRef.innerHTML;
								activeLinkNode = null;
							}
						}}
						class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors border-none bg-transparent cursor-pointer"
						title="Unlink"
					>
						<Icon name="lucide:unlink" class="w-3.5 h-3.5" />
					</button>

					<button
						type="button"
						onclick={() => {
							navigator.clipboard.writeText(linkEditUrl);
							copySuccess = true;
							setTimeout(() => copySuccess = false, 1500);
						}}
						class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors border-none bg-transparent cursor-pointer relative"
						title={copySuccess ? "Copied!" : "Copy link"}
					>
						<Icon name={copySuccess ? "lucide:check" : "lucide:copy"} class="w-3.5 h-3.5 {copySuccess ? 'text-green-400' : ''}" />
					</button>

					<a
						href="https://id.atlassian.com/manage-profile/link-preferences"
						target="_blank"
						rel="noopener noreferrer"
						class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
						title="Go to Link Preferences"
					>
						<Icon name="lucide:settings" class="w-3.5 h-3.5" />
					</a>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if activeCodeNode && isCodeActive && enableCodeToolbar}
	<div
		bind:this={codeToolbarRef}
		id="code-block-toolbar"
		style="top: {codeToolbarCoords.top}px; left: {codeToolbarCoords.left}px; transform: translateX(-50%);"
		class="absolute z-50 p-1 rounded-lg border border-slate-700 bg-slate-950 shadow-2xl flex items-center gap-1 text-xs select-none"
	>
		<!-- Language Dropdown -->
		<select
			value={activeCodeLanguage}
			onchange={(e) => handleSelectCodeLanguage(e.currentTarget.value)}
			class="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 cursor-pointer min-w-28 relative z-50"
		>
			{#each codeLanguages as lang}
				<option value={lang.id}>{lang.name}</option>
			{/each}
		</select>

		<div class="h-4 w-[1px] bg-slate-700 mx-1"></div>

		<!-- Wrap toggle -->
		<button
			type="button"
			onmousedown={(e) => e.preventDefault()}
			onclick={handleToggleCodeWrap}
			class="p-1 rounded hover:bg-slate-800 border-none cursor-pointer text-slate-400 hover:text-slate-200 flex items-center justify-center transition-colors {activeCodeIsWrapped ? 'bg-slate-850 text-violet-400' : 'bg-transparent'}"
			title="Wrap lines"
		>
			<Icon name="lucide:wrap-text" class="w-4 h-4" />
		</button>
		
		<!-- Delete snippet button -->
		<button
			type="button"
			onmousedown={(e) => e.preventDefault()}
			onclick={handleDeleteCodeBlock}
			class="p-1 rounded hover:bg-slate-800 border-none cursor-pointer text-slate-400 hover:text-red-400 flex items-center justify-center transition-colors bg-transparent"
			title="Delete code block"
		>
			<Icon name="lucide:trash" class="w-4 h-4" />
		</button>
	</div>
{/if}

{#if showFormattingHelp}
	<div class="mt-2 p-3 bg-slate-900 rounded-lg border border-slate-850 text-xs leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200 select-none">
		<div class="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
			<span class="font-bold text-slate-300">Formatting help</span>
			<button type="button" onclick={() => showFormattingHelp = false} class="bg-transparent hover:text-slate-200 text-slate-500 border-none cursor-pointer transition-colors p-0">
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>
		<div class="grid grid-cols-2 gap-3 text-slate-400 font-medium">
			<div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold"># Heading</span> for Header 1</div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">## Heading</span> for Header 2</div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">**text**</span> for <strong class="text-slate-300">Bold</strong></div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">*text*</span> for <em class="text-slate-300">Italic</em></div>
			</div>
			<div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">~~text~~</span> for <del class="text-slate-300">Strikethrough</del></div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">`code`</span> for inline code</div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">```</span> on empty line for code snippet block</div>
				<div class="mb-1.5"><span class="text-slate-300 bg-slate-950 px-1 py-0.5 rounded font-mono border border-slate-800 font-bold">&gt; text</span> for block quote</div>
			</div>
		</div>
	</div>
{/if}

<style>
	[contenteditable="true"] {
		font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
	}
	[contenteditable="true"] :global(h1) {
		font-size: 1.5rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(h2) {
		font-size: 1.25rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(h3) {
		font-size: 1.125rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(p) {
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(strong) {
		font-weight: 700 !important;
		color: rgb(241 245 249) !important;
	}
	[contenteditable="true"] :global(em) {
		font-style: italic !important;
	}
	[contenteditable="true"] :global(ul) {
		list-style-type: disc !important;
		padding-left: 1.25rem !important;
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(ol) {
		list-style-type: decimal !important;
		padding-left: 1.25rem !important;
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	[contenteditable="true"] :global(li) {
		display: list-item !important;
		margin-top: 0.25rem !important;
		margin-bottom: 0.25rem !important;
	}
	[contenteditable="true"] :global(pre) {
		background-color: rgb(15 23 42) !important;
		color: rgb(241 245 249) !important;
		padding: 0.75rem 0.75rem 0.75rem 1.75rem !important;
		border-radius: 0.5rem !important;
		border: 1px solid rgb(51 65 85) !important;
		font-family: monospace !important;
		font-size: 0.875rem !important;
		margin: 1rem 0 !important;
		overflow-x: auto !important;
		position: relative !important;
	}
	[contenteditable="true"] :global(pre)::before {
		content: "" !important;
		position: absolute !important;
		left: 0 !important;
		top: 0 !important;
		bottom: 0 !important;
		width: 1.75rem !important;
		background-color: rgba(30, 41, 59, 0.4) !important;
		border-right: 1px solid rgba(71, 85, 105, 0.4) !important;
		border-radius: 0.5rem 0 0 0.5rem !important;
		pointer-events: none !important;
	}
	[contenteditable="true"] :global(pre code) {
		background-color: transparent !important;
		padding: 0 !important;
		border-radius: 0 !important;
		font-size: 1em !important;
		display: block !important;
		counter-reset: line !important;
	}
	[contenteditable="true"] :global(pre code div) {
		position: relative !important;
		padding-left: 0.6rem !important;
	}
	[contenteditable="true"] :global(pre code div)::before {
		counter-increment: line !important;
		content: counter(line) !important;
		position: absolute !important;
		top: 0 !important;
		bottom: 0 !important;
		left: -1.75rem !important;
		width: 1.75rem !important;
		display: inline-flex !important;
		align-items: center !important;
		justify-content: center !important;
		color: rgb(100 116 139) !important;
		font-size: 0.75rem !important;
		font-family: monospace !important;
		pointer-events: none !important;
		user-select: none !important;
	}
	[contenteditable="true"] :global(blockquote) {
		border-left: 0.25rem solid rgb(139 92 246) !important;
		padding-left: 1rem !important;
		color: rgb(148 163 184) !important;
		margin: 0.5rem 0 !important;
		font-style: italic !important;
	}
	[contenteditable="true"] :global(pre code .token-keyword) {
		color: #569cd6 !important;
		font-weight: 500;
	}
	[contenteditable="true"] :global(pre code .token-string) {
		color: #80c990 !important;
	}
	[contenteditable="true"] :global(pre code .token-comment) {
		color: #6a9955 !important;
		font-style: italic;
	}
	[contenteditable="true"] :global(pre code .token-number) {
		color: #b5cea8 !important;
	}
	[contenteditable="true"] :global(pre code .token-function) {
		color: #dcdcaa !important;
	}
	[contenteditable="true"] :global(pre code .token-builtin) {
		color: #4fc1ff !important;
	}
	[contenteditable="true"] :global(pre code .token-operator) {
		color: #d4d4d4 !important;
	}
	[contenteditable="true"] :global(a) {
		color: #579dff !important;
		text-decoration: underline !important;
		cursor: pointer !important;
	}
	[contenteditable="true"] :global(a:hover) {
		color: #85b8ff !important;
	}
</style>
