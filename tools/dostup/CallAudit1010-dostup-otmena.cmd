@echo off
rem CallAudit1010: undo the access fix (removes our line from hosts).
rem Keep this file next to CallAudit1010-dostup.cmd.
call "%~dp0CallAudit1010-dostup.cmd" remove
