-- Safari Markdown Exporter
-- Extracts page content as markdown and saves to Obsidian
-- Supports both web pages and PDFs
-- Keyboard shortcut: Set up via Automator Quick Action

-- Path to Python script (same folder as this script)
property pythonScript : "/Users/varunr/projects/test/safari-markdown-exporter.py"
property tempHtmlFile : "/tmp/safari-markdown-export.html"
property tempPdfFile : "/tmp/safari-markdown-export.pdf"

-- Main script
on run
	tell application "Safari"
		activate

		-- Get URL and title from current tab
		set pageURL to URL of current tab of front window
		set pageTitle to name of current tab of front window
	end tell

	-- Check if this is a PDF
	set isPDF to (pageURL ends with ".pdf") or (pageURL ends with ".PDF")

	if isPDF then
		-- Handle PDF: download the file directly
		try
			do shell script "curl -L -s -o " & quoted form of tempPdfFile & " " & quoted form of pageURL
		on error errMsg
			display notification "Failed to download PDF: " & errMsg with title "Export Failed" sound name "Basso"
			return
		end try

		-- Call Python script with --pdf flag
		try
			set pythonPath to "/Users/varunr/projects/test/venv311/bin/python3"
			set exportResult to do shell script pythonPath & " " & quoted form of pythonScript & " " & quoted form of tempPdfFile & " " & quoted form of pageURL & " " & quoted form of pageTitle & " --pdf"
			set savedFilename to exportResult
		on error errMsg
			display notification "Python error: " & errMsg with title "Export Failed" sound name "Basso"
			do shell script "rm -f " & quoted form of tempPdfFile
			return
		end try

		-- Clean up temp file
		do shell script "rm -f " & quoted form of tempPdfFile

		-- Show success notification
		display notification "Saved PDF: " & savedFilename with title "Markdown Exported" sound name "Pop"

	else
		-- Handle web page: use Reader Mode and extract HTML
		set readerWasToggled to false
		tell application "System Events"
			tell process "Safari"
				-- Check if Reader Mode menu item exists and is available
				try
					set readerMenuItem to menu item "Show Reader" of menu "View" of menu bar 1
					if enabled of readerMenuItem then
						click readerMenuItem
						set readerWasToggled to true
						delay 0.8 -- Wait for Reader Mode to render
					end if
				on error
					-- Reader not available for this page, continue anyway
				end try
			end tell
		end tell

		-- Extract full HTML from page
		tell application "Safari"
			tell current tab of front window
				set pageHTML to do JavaScript "document.documentElement.outerHTML"
			end tell
		end tell

		-- Write HTML to temp file
		try
			do shell script "cat > " & quoted form of tempHtmlFile & " << 'EOFHTML'
" & pageHTML & "
EOFHTML"
		on error errMsg
			display notification "Failed to write temp file: " & errMsg with title "Export Failed" sound name "Basso"
			return
		end try

		-- Call Python script
		try
			set pythonPath to "/Users/varunr/projects/test/venv311/bin/python3"
			set exportResult to do shell script pythonPath & " " & quoted form of pythonScript & " " & quoted form of tempHtmlFile & " " & quoted form of pageURL & " " & quoted form of pageTitle
			set savedFilename to exportResult
		on error errMsg
			display notification "Python error: " & errMsg with title "Export Failed" sound name "Basso"
			do shell script "rm -f " & quoted form of tempHtmlFile
			if readerWasToggled then
				tell application "System Events"
					tell process "Safari"
						try
							click menu item "Hide Reader" of menu "View" of menu bar 1
						end try
					end tell
				end tell
			end if
			return
		end try

		-- Clean up temp file
		do shell script "rm -f " & quoted form of tempHtmlFile

		-- Exit Reader Mode if we toggled it
		if readerWasToggled then
			tell application "System Events"
				tell process "Safari"
					try
						click menu item "Hide Reader" of menu "View" of menu bar 1
					end try
				end tell
			end tell
		end if

		-- Scroll to bottom of page (indicates completion)
		tell application "Safari"
			tell current tab of front window
				do JavaScript "window.scrollTo(0, document.body.scrollHeight);"
			end tell
		end tell

		-- Show success notification
		display notification "Saved: " & savedFilename with title "Markdown Exported" sound name "Pop"
	end if
end run
