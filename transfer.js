'use strict';

var gui = require('nw.gui');

// var quit = new gui.MenuItem({label: 'Quit'});

// quit.on('click', function () {
//   gui.App.quit();
// });

// menu.append(quit);

var menu = new gui.Menu({type: 'menubar'});

menu.createMacBuiltin('Transfer');

// XXX: You'd think this would be equivalent but it doesn't work!
// var window = gui.Window.get();
// window.menu = menu;

gui.Window.get().menu = menu;

// Bring the window to the top
gui.Window.get().show();
gui.Window.get().focus();
