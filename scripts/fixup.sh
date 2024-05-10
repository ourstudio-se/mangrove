#!/bin/sh

project_dir=$1
lib_dir=$project_dir/lib
esm_dir=$lib_dir/esm
cjs_dir=$lib_dir/cjs

if [[ -d "$esm_dir" ]]; then
	cat >$esm_dir/package.json <<!EOF
  {
      "type": "module"
  }
!EOF
else
	echo "[$PWD] No ESM directory found in $esm_dir, skipping..."
fi

if [[ -d "$cjs_dir" ]]; then
	cat >$cjs_dir/package.json <<!EOF
  {
      "type": "commonjs"
  }
!EOF
else
	echo "[$PWD] No CJS directory found in $cjs_dir, skipping..."
fi
