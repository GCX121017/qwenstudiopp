@echo off
echo Uninstalling global command 'qspp' ...
call npm uninstall -g qwen-studio-pp
echo.
echo Done. Local config and credentials are kept at:
echo   %USERPROFILE%\.qwen-studio-pp
echo Delete that folder manually if you want a full cleanup.
pause
