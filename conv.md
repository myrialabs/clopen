
# Diskusi Bug Profile Clopen
**Tanggal:** 11 Juli 2026

---

## 🕧 12:35 — Agung

Saya mencoba fitur **Profile**. Lalu saya bertanya ke AI mengenai skill apa saja yang aktif sesuai profile yang dipilih. Saat diminta melakukan investigasi, AI memberikan hasil berikut:

### 🔴 BUG: Memilih Profile "Frontend" Tidak Tersimpan ke Database

**Lokasi file:**
- `frontend/components/chat/input/components/ProfilePicker.svelte` (baris 77–88)
- `backend/ws/chat/stream.ts` (baris 865–882)

### Alur yang seharusnya terjadi

1. Pengguna memilih profile **Frontend** pada dropdown.
2. Nilai `chatModelState.profileId` berubah menjadi `1` (tersimpan di memori).
3. Nilai tersebut seharusnya dikirim ke server melalui WebSocket `chat:profile-sync`.
4. Server kemudian menjalankan query:

```sql
UPDATE chat_sessions
SET profile_id = 1;
```

Namun kenyataannya, data di database tidak berubah.

Semua session masih memiliki:

```text
profile_id = NULL
```

### Yang sudah dicek

- ✅ Profile **Frontend** (`id = 1`) sudah ada di tabel `profiles`.
- ✅ Profile **Backend** (`id = 2`) juga sudah ada di tabel `profiles`.

---

## 🕧 12:36

**Agung**

Sepertinya `profile_id` tidak ikut dimuat ke dalam session.

**Arga**

Pakai model apa, Gung?

**Agung**

Opencode.

---

## 🕧 12:37

**Arga**

Sudah coba restart engine?

**Agung**

Sudah.

---

## 🕧 12:38

**Agung**

Masih **0 dari 12 session** yang berhasil menggunakan profile.

Data di database juga belum berubah.

Berarti bug-nya memang benar ada.

Kemungkinan event `chat:profile-sync` tidak sampai atau gagal diproses oleh server.

---

## 🕧 12:39

**Arga**

Coba tes dengan pertanyaan berikut:

```text
Apa saja skills dan MCP yang tersedia?
```

---

## 🕧 12:40

**Arga**

Kemarin saya coba menggunakan Claude Code dan Opencode, hasilnya bisa mendeteksi dengan benar saat ditanya seperti itu.

**Agung**

AI menjawab:

### Skills (7)

- browser-use
- caveman
- fix
- frontend-design
- pdf
- read-only-sql-investigation
- typescript-write

### MCP (1)

- browser-automation

### Lainnya

**Commands**

- kill-port

**Subagents**

- diff-review-ux
- diff-reviewer

---

## 🕧 12:41

**Agung**

Semua skill ikut dimuat.

Padahal `read-only-sql-investigation` adalah skill milik profile **Backend**, sedangkan saya sedang menggunakan profile **Frontend**.

Skill itu seharusnya tidak muncul.

**Arga**

Skill `read-only-sql` itu dikonfigurasi di Clopen atau di luar Clopen?

*(mengirim foto)*

Oh begitu.

---

## 🕧 12:42

**Agung**

Skill `read-only` itu memang baru dibuat.

---

## 🕧 12:43

**Arga**

Kalau skill tersebut dinonaktifkan melalui menu **Settings → Skills**, apakah ada pengaruhnya?

---

## 🕧 12:44

**Arga**

Kalau berpengaruh, berarti memang masalahnya ada pada fitur **Profile**.

---

## 🕧 12:49

**Agung**

Saya juga mencoba membuka session baru.

Namun skill dan MCP milik Clopen justru tidak muncul.

Prompt:

```text
Apa saja skills dan MCP yang tersedia?
```

Jawaban AI:

# 🎖️ Kapten — Skills & MCP Inventory

## Skills (11)

- caveman
- codegen-patterns
- coding-standards
- customize-opencode
- design-system
- find-skills
- paperclip
- paperclip-create-agent
- paperclip-create-plugin
- para-memory-files
- ui-ux

## MCP Tools (10)

- analyze_dom
- take_screenshot
- navigate
- dan lain-lain

---

## 🕧 12:50

**Agung**

Kemudian saya meminta Clopen mengecek setelah skill SQL saya nonaktifkan.

Hasilnya:

```text
Clopen Only

CLOPEN:SKILLS (6)

- frontend-design
- typescript-write
- pdf
- fix
- browser-use
- caveman

MCP Tools (10)

- analyze_dom
- take_screenshot
- navigate
- actions
- open_new_tab
- switch_tab
- close_tab
- list_tabs
- execute_console
- get_console_logs

Commands

- kill-port

Subagents

- diff-review-ux
- diff-reviewer
```

---

## 🕧 12:53

**Arga**

Kadang daftar skill memang tidak ditampilkan secara lengkap.

Coba tanyakan lagi:

```text
Apakah skill read-only-sql-investigation tersedia?
```

---

## 🕧 12:54

**Arga**

Kalau hasilnya tetap seperti sebelumnya, berarti sudah terkonfirmasi.

Yang benar-benar berpengaruh hanyalah pengaturan **Skills**, sedangkan **Profile** sama sekali tidak diterapkan.

---

## 🕧 12:54

**Arga**

Nanti saya coba perbaiki lagi.

---

## 🕧 12:55

**Agung**

Skill `read-only-sql-investigation` memang ada di filesystem:

```text
skills/read-only-sql-investigation/SKILL.md
```

Tetapi belum terdaftar pada blok `CLOPEN:SKILLS` di file `AGENTS.md`.

---

## 🕧 12:55

**Arga**

Oke, terima kasih Gung. 👍

---

# Kesimpulan

- ✅ Pengaturan **Skills** berfungsi dengan baik.
- ❌ Fitur **Profile** tidak diterapkan saat chat berlangsung.
- ❌ `profile_id` tidak tersimpan ke tabel `chat_sessions`.
- ❌ Session tetap menggunakan skill bawaan/default, bukan skill sesuai profile yang dipilih.
- 🔍 Dugaan utama adalah event WebSocket `chat:profile-sync` tidak terkirim atau gagal diproses oleh server.