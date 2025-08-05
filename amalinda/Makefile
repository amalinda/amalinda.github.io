all:
	./website.py
	# $(MAKE) -C cv
	# mkdir -p html/cv/
	# cp cv/amalinda.pdf static/cv/

local:	all
	pushd html && python3 -m http.server 8000; popd

deploy:	all
	# Add the current source directory's changes and commit with the timestamp, then pull and push
	git add . 
	git diff --quiet && git diff --staged --quiet || (git commit -m "Source auto update: `date +'%Y-%m-%d %H:%M:%S'`" && git pull origin master --allow-unrelated-histories -X theirs && git push origin master)
	
	# rsync -avP html/ root@nws.sg:/home/user-data/www/nws.sg/amalinda
	#cd html && mkdir -p amalinda && rsync -av --exclude='.git' --exclude='amalinda' --exclude='CNAME' . amalinda/ && find . -maxdepth 1 -type d ! -name '.git' ! -name 'amalinda' ! -name '.' -exec rm -rf {} \; && find . -maxdepth 1 -type f ! -name 'CNAME' -exec rm -f {} \; && git add . && git diff --quiet && git diff --staged --quiet || (git commit -m "Auto update: `date +'%Y-%m-%d %H:%M:%S'`" || true) && git pull origin master --allow-unrelated-histories -X theirs && git push origin master
	cd html && mkdir -p amalinda && rsync -av --exclude='.git' --exclude='amalinda' --exclude='CNAME' . amalinda/ && find . -maxdepth 1 -type d ! -name '.git' ! -name 'amalinda' ! -name '.' -exec rm -rf {} \; && find . -maxdepth 1 -type f ! -name 'CNAME' -exec rm -f {} \; && git add . && git diff --quiet && git diff --staged --quiet || (git commit -m "Auto update: `date +'%Y-%m-%d %H:%M:%S'`" || true) && git pull origin master --allow-unrelated-histories -X theirs && git push origin master

.PHONY: all local deploy